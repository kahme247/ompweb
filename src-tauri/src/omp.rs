//! Process + protocol layer for `omp --mode rpc-ui` (NDJSON over stdio).
//! Rust port of `lib/omp/rpc-process.ts`, scoped to protocol v1: commands
//! `{id, type, ...}` on stdin; `{type:"response", id, ...}` plus interleaved
//! event frames on stdout. omp announces readiness with a `{type:"ready"}`
//! frame before accepting commands. Non-response frames are forwarded to the
//! webview as `omp-frame` events.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::rpc_frame::{encode_rpc_frames, RpcFrameDecoder};

const STDERR_TAIL_LIMIT: usize = 8 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(60);

pub struct OmpSession {
    #[allow(dead_code)]
    pub cwd: String,
    stdin: Mutex<Option<std::process::ChildStdin>>,
    next_id: Mutex<u64>,
    chunk_counter: AtomicU64,
    /// Active RPC protocol version (1 until v2 is negotiated).
    protocol_version: AtomicU8,
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    stderr_tail: Arc<Mutex<String>>,
    pid: u32,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct OmpState {
    /// One omp session per chat window, keyed by the Tauri window label
    /// ("main", "chat-1", ...). Frames are routed back with emit_to so two
    /// project windows never see each other's streams.
    pub sessions: Mutex<HashMap<String, Arc<OmpSession>>>,
    /// Project cwd each chat window was opened for (label → cwd).
    pub window_cwds: Mutex<HashMap<String, String>>,
    pub next_chat_window: AtomicU32,
}

fn poisoned() -> String {
    "omp session lock poisoned".to_string()
}

impl OmpSession {
    fn write_line(&self, value: &Value) -> Result<(), String> {
        let chunk_n = self.chunk_counter.fetch_add(1, Ordering::Relaxed);
        let lines = encode_rpc_frames(
            value,
            self.protocol_version.load(Ordering::Relaxed),
            &format!("rust-{chunk_n}"),
        )?;
        let mut guard = self.stdin.lock().map_err(|_| poisoned())?;
        let stdin = guard.as_mut().ok_or("omp RPC process is not running")?;
        for line in &lines {
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| format!("omp stdin write failed: {e}"))?;
        }
        stdin.flush().map_err(|e| format!("omp stdin flush failed: {e}"))
    }

    /// Send a command and wait for its matching response. Resolves with the
    /// response `data` on success, errors with the omp-provided message
    /// otherwise. No timeout by default — prompts legitimately take minutes.
    fn send(&self, mut command: Value) -> Result<Value, String> {
        let id = {
            let mut next = self.next_id.lock().map_err(|_| poisoned())?;
            *next += 1;
            format!("w{}", *next)
        };
        command["id"] = json!(id.clone());
        let (tx, rx) = channel();
        self.pending
            .lock()
            .map_err(|_| poisoned())?
            .insert(id.clone(), tx);
        if let Err(e) = self.write_line(&command) {
            self.pending.lock().map_err(|_| poisoned())?.remove(&id);
            return Err(e);
        }
        match rx.recv() {
            Ok(response) => {
                if response["success"].as_bool().unwrap_or(false) {
                    Ok(response["data"].clone())
                } else {
                    Err(response["error"].as_str().unwrap_or("RPC command failed").to_string())
                }
            }
            Err(_) => Err(format!(
                "omp exited before responding: {}",
                self.stderr_tail_snapshot()
            )),
        }
    }

    fn stderr_tail_snapshot(&self) -> String {
        self.stderr_tail.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// Enables bounded protocol-v2 framing when the ready frame advertises it.
    /// Negotiation itself rides v1 (small frame); on success the session
    /// switches its encoder/decoder expectations to v2.
    fn negotiate_protocol(&self, ready: &Value) -> Result<(), String> {
        let has_v2 = ready["supportedProtocolVersions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_i64() == Some(2)));
        if !has_v2 {
            return Ok(());
        }
        let data = self.send(json!({ "type": "negotiate_protocol", "protocolVersion": 2 }))?;
        if data["protocolVersion"].as_i64() == Some(2) {
            self.protocol_version.store(2, Ordering::Relaxed);
            Ok(())
        } else {
            Err("OMP rejected RPC protocol v2 negotiation".to_string())
        }
    }

    /// Graceful shutdown: close stdin (omp exits on EOF); on Windows, if the
    /// child is still alive shortly after, kill the whole process tree with
    /// taskkill so extension/LSP grandchildren don't linger.
    pub fn stop(&self) {
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take(); // dropping ChildStdin closes the pipe
        }
        let exited = Arc::clone(&self.exited);
        let pid = self.pid;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if !exited.load(Ordering::Relaxed) {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/t", "/f"])
                        .creation_flags(0x0800_0000)
                        .status();
                }
            }
        });
    }
}

fn resolve_omp_bin() -> String {
    std::env::var("OMP_WEB_OMP_BIN").unwrap_or_else(|_| "omp".to_string())
}

struct Spawned {
    session: Arc<OmpSession>,
    ready_rx: std::sync::mpsc::Receiver<Value>,
}

fn spawn_session(
    app: tauri::AppHandle,
    label: String,
    cwd: &str,
    resume: Option<&str>,
    approval_mode: Option<&str>,
) -> Result<Spawned, String> {
    let mut cmd = Command::new(resolve_omp_bin());
    cmd.args(["--mode", "rpc-ui", "--cwd", cwd]);
    // An absolute session-file path resolves deterministically in omp's
    // createSessionManager — no interactive resume/fork prompts (see
    // rpc-manager.ts buildSessionSpawnArgs).
    if let Some(file) = resume {
        if !file.trim().is_empty() {
            cmd.arg("--resume").arg(file);
        }
    }
    // Only omp's own approval modes are passed through; anything else starts
    // with the config default.
    if let Some(mode) = approval_mode {
        if matches!(mode, "always-ask" | "write" | "yolo") {
            cmd.arg(format!("--approval-mode={mode}"));
        }
    }
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: omp is a console app; spawning it from a GUI
        // process must not flash a console window.
        cmd.creation_flags(0x0800_0000);
    }

    let mut child: Child = cmd.spawn().map_err(|e| format!("failed to spawn omp: {e}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or("failed to capture omp stdin")?;
    let stdout = child.stdout.take().ok_or("failed to capture omp stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture omp stderr")?;

    let pending: Arc<Mutex<HashMap<String, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let exited = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Value>();

    // Built before the threads so the reader can reach stop()/protocol state.
    let session = Arc::new(OmpSession {
        cwd: cwd.to_string(),
        stdin: Mutex::new(Some(stdin)),
        next_id: Mutex::new(0),
        chunk_counter: AtomicU64::new(0),
        protocol_version: AtomicU8::new(1),
        pending: Arc::clone(&pending),
        stderr_tail: Arc::clone(&stderr_tail),
        pid,
        exited: Arc::clone(&exited),
    });

    // stdout reader: reassemble v2 chunks, correlate responses, forward
    // everything else as events. Protocol errors are fatal (the TS layer
    // disposes the process too).
    {
        let session = Arc::clone(&session);
        let pending = Arc::clone(&pending);
        let tail = Arc::clone(&stderr_tail);
        let app = app.clone();
        let label = label.clone();
        std::thread::spawn(move || {
            let mut decoder = RpcFrameDecoder::new();
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
                    // omp guards stdout in RPC mode; never let a stray line kill the reader.
                    continue;
                };
                if parsed["type"] == *"rpc_chunk" && session.protocol_version.load(Ordering::Relaxed) < 2 {
                    if let Ok(mut t) = tail.lock() {
                        t.push_str("\nRPC protocol error: RPC chunk received before protocol negotiation");
                    }
                    session.stop();
                    break;
                }
                let frame = match decoder.push(parsed) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => continue,
                    Err(e) => {
                        if let Ok(mut t) = tail.lock() {
                            t.push_str(&format!("\nRPC protocol error: {e}"));
                        }
                        session.stop();
                        break;
                    }
                };
                match frame["type"].as_str() {
                    Some("ready") => {
                        let _ = ready_tx.send(frame);
                    }
                    Some("agent_start") => {
                        crate::shell::report_agent_state(&app, true, &session.cwd);
                        let _ = app.emit_to(&label, "omp-frame", frame);
                    }
                    Some("agent_end") => {
                        crate::shell::report_agent_state(&app, false, &session.cwd);
                        let _ = app.emit_to(&label, "omp-frame", frame);
                    }
                    Some("response") => {
                        let id = frame["id"].as_str().map(|s| s.to_string());
                        let sender = id.and_then(|id| {
                            pending.lock().ok().and_then(|mut p| p.remove(&id))
                        });
                        match sender {
                            Some(tx) => {
                                let _ = tx.send(frame);
                            }
                            // Unsolicited response — surface it so nothing is silently dropped.
                            None => {
                                let _ = app.emit_to(&label, "omp-frame", frame);
                            }
                        }
                    }
                    _ => {
                        let _ = app.emit_to(&label, "omp-frame", frame);
                    }
                }
            }
        });
    }

    // stderr tail (bounded, for error messages).
    {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    t.push('\n');
                    t.push_str(&line);
                    if t.len() > STDERR_TAIL_LIMIT {
                        let cut = t.len() - STDERR_TAIL_LIMIT;
                        t.drain(..cut);
                    }
                }
            }
        });
    }

    // exit watcher: owns the child, fails all pending commands, notifies the UI.
    {
        let pending = Arc::clone(&pending);
        let exited = Arc::clone(&exited);
        let tail = Arc::clone(&stderr_tail);
        let app = app.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.code(),
                Err(_) => None,
            };
            exited.store(true, Ordering::Relaxed);
            pending.lock().ok().map(|mut p| p.clear());
            if let Some(state) = app.try_state::<OmpState>() {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(&label);
                }
            }
            crate::shell::report_session_gone(&app);
            let tail_text = tail.lock().map(|t| t.clone()).unwrap_or_default();
            let _ = app.emit_to(&label, "omp-exit", json!({ "code": code, "stderrTail": tail_text }));
        });
    }

    Ok(Spawned {
        session,
        ready_rx,
    })
}

/// Start an omp RPC session in the given cwd for the calling window.
/// Resolves with the `ready` frame.
#[tauri::command]
async fn omp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmpState>,
    window: tauri::Window,
    cwd: String,
    resume: Option<String>,
    approval_mode: Option<String>,
) -> Result<Value, String> {
    let label = window.label().to_string();
    // Only one session per window — dispose any previous one.
    if let Some(old) = state
        .sessions
        .lock()
        .map_err(|_| poisoned())?
        .remove(&label)
    {
        old.stop();
    }

    let app = app.clone();
    let label_for_task = label.clone();
    let (session, ready) = tauri::async_runtime::spawn_blocking(move || {
        let spawned = spawn_session(app, label_for_task.clone(), &cwd, resume.as_deref(), approval_mode.as_deref())?;
        let frame = spawned
            .ready_rx
            .recv_timeout(READY_TIMEOUT)
            .map_err(|_| "omp RPC ready timeout after 60s".to_string())?;
        spawned.session.negotiate_protocol(&frame)?;
        Ok::<_, String>((spawned.session, frame))
    })
    .await
    .map_err(|e| format!("omp start task failed: {e}"))??;

    state
        .sessions
        .lock()
        .map_err(|_| poisoned())?
        .insert(label, session);
    Ok(ready)
}

/// Forward an arbitrary RPC command to the running omp session.
#[tauri::command]
async fn omp_send(
    state: tauri::State<'_, OmpState>,
    window: tauri::Window,
    command: Value,
) -> Result<Value, String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| poisoned())?
        .get(window.label())
        .cloned()
        .ok_or("omp session not started")?;
    tauri::async_runtime::spawn_blocking(move || session.send(command))
        .await
        .map_err(|e| format!("omp send task failed: {e}"))?
}

/// Stop the calling window's omp session (stdin EOF, then tree-kill on Windows).
#[tauri::command]
async fn omp_stop(state: tauri::State<'_, OmpState>, window: tauri::Window) -> Result<(), String> {
    if let Some(session) = state
        .sessions
        .lock()
        .map_err(|_| poisoned())?
        .remove(window.label())
    {
        session.stop();
    }
    Ok(())
}

/// The user's home directory (initial cwd suggestion for the test page).
#[tauri::command]
fn omp_home() -> Result<String, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot determine home directory".to_string())
}

#[tauri::command]
fn omp_list_sessions() -> Result<Vec<Value>, String> {
    crate::sessions::list_sessions()
}

#[tauri::command]
fn omp_read_session(file: String) -> Result<Vec<Value>, String> {
    crate::sessions::read_session(&file)
}

/// Composer context row: project label (cwd basename) and current git branch.
#[tauri::command]
fn omp_cwd_info(cwd: String) -> Value {
    let project = std::path::Path::new(&cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.clone());
    let mut branch = String::new();
    let mut diff_added: u64 = 0;
    let mut diff_removed: u64 = 0;
    let git = |args: &[&str], parse: &mut dyn FnMut(&str)| {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: git is a console app spawned from a GUI process.
            cmd.creation_flags(0x0800_0000);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout).to_string();
                for line in text.lines() {
                    parse(line);
                }
            }
        }
    };
    git(&["branch", "--show-current"], &mut |line| {
        if branch.is_empty() {
            branch = line.trim().to_string();
        }
    });
    // Working-tree churn vs HEAD (staged + unstaged); binary lines ("-	-") ignored.
    git(&["diff", "HEAD", "--numstat"], &mut |line| {
        let mut cols = line.split('\t');
        if let (Some(add), Some(rem)) = (cols.next(), cols.next()) {
            if let Ok(a) = add.parse::<u64>() {
                diff_added += a;
            }
            if let Ok(r) = rem.parse::<u64>() {
                diff_removed += r;
            }
        }
    });
    json!({ "project": project, "branch": branch, "diffAdded": diff_added, "diffRemoved": diff_removed })
}

/// Settings surface for the UI; keys are stable identifiers.
#[tauri::command]
fn omp_shell_settings(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(crate::shell::settings(&app))
}

#[tauri::command]
fn omp_shell_set_setting(app: tauri::AppHandle, key: String, value: bool) -> Result<(), String> {
    crate::shell::set_setting(&app, &key, value)
}

/// Open a chat window for a project (one per cwd — focusing an existing
/// window for the same project instead of duplicating). Returns the label.
#[tauri::command]
fn omp_open_project_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmpState>,
    cwd: String,
) -> Result<String, String> {
    {
        let map = state.window_cwds.lock().map_err(|_| poisoned())?;
        for (label, existing) in map.iter() {
            if existing == &cwd {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    return Ok(label.clone());
                }
            }
        }
    }
    let n = state.next_chat_window.fetch_add(1, Ordering::Relaxed);
    let label = format!("chat-{n}");
    let title = std::path::Path::new(&cwd)
        .file_name()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.clone());
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html?boot=chat".into()),
    )
    .title(title)
    .inner_size(1280.0, 800.0)
    .min_inner_size(720.0, 480.0)
    .decorations(false)
    .build()
    .map_err(|e| e.to_string())?;
    state
        .window_cwds
        .lock()
        .map_err(|_| poisoned())?
        .insert(label.clone(), cwd);
    Ok(label)
}

/// Boot info for a chat window: the project cwd it was opened for.
#[tauri::command]
fn omp_window_boot(state: tauri::State<'_, OmpState>, window: tauri::Window) -> Result<Value, String> {
    let cwd = state
        .window_cwds
        .lock()
        .map_err(|_| poisoned())?
        .get(window.label())
        .cloned();
    Ok(json!({ "label": window.label(), "cwd": cwd }))
}

/// The command macros are module-scoped, so the handler is assembled here
/// where they resolve; lib.rs wires this straight into invoke_handler.
pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    use crate::workspace;
    tauri::generate_handler![
        omp_start,
        omp_send,
        omp_stop,
        omp_home,
        omp_list_sessions,
        omp_read_session,
        omp_cwd_info,
        omp_shell_settings,
        omp_shell_set_setting,
        omp_open_project_window,
        omp_window_boot,
        workspace::omp_list_projects,
        workspace::omp_pick_folder,
        workspace::omp_git_branches,
        workspace::omp_git_checkout,
        workspace::omp_list_worktrees,
        workspace::omp_new_worktree,
        workspace::omp_reveal_path,
        workspace::omp_copy_text,
        workspace::omp_read_image,
        workspace::omp_list_skills,
        workspace::omp_read_skill,
        workspace::omp_set_skill_disabled,
        workspace::omp_delete_skill
    ]
}
