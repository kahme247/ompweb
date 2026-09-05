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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

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
pub struct OmpState(pub Mutex<Option<Arc<OmpSession>>>);

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
    fn stop(&self) {
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

fn spawn_session(app: tauri::AppHandle, cwd: &str, resume: Option<&str>) -> Result<Spawned, String> {
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
                                let _ = app.emit("omp-frame", frame);
                            }
                        }
                    }
                    _ => {
                        let _ = app.emit("omp-frame", frame);
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
            let tail_text = tail.lock().map(|t| t.clone()).unwrap_or_default();
            let _ = app.emit("omp-exit", json!({ "code": code, "stderrTail": tail_text }));
        });
    }

    Ok(Spawned {
        session,
        ready_rx,
    })
}

/// Start an omp RPC session in the given cwd. Resolves with the `ready` frame.
#[tauri::command]
async fn omp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmpState>,
    cwd: String,
    resume: Option<String>,
) -> Result<Value, String> {
    // Only one session per window for now — dispose any previous one.
    if let Some(old) = state.0.lock().map_err(|_| poisoned())?.take() {
        old.stop();
    }

    let app = app.clone();
    let (session, ready) = tauri::async_runtime::spawn_blocking(move || {
        let spawned = spawn_session(app, &cwd, resume.as_deref())?;
        let frame = spawned
            .ready_rx
            .recv_timeout(READY_TIMEOUT)
            .map_err(|_| "omp RPC ready timeout after 60s".to_string())?;
        spawned.session.negotiate_protocol(&frame)?;
        Ok::<_, String>((spawned.session, frame))
    })
    .await
    .map_err(|e| format!("omp start task failed: {e}"))??;

    *state.0.lock().map_err(|_| poisoned())? = Some(session);
    Ok(ready)
}

/// Forward an arbitrary RPC command to the running omp session.
#[tauri::command]
async fn omp_send(state: tauri::State<'_, OmpState>, command: Value) -> Result<Value, String> {
    let session = state
        .0
        .lock()
        .map_err(|_| poisoned())?
        .clone()
        .ok_or("omp session not started")?;
    tauri::async_runtime::spawn_blocking(move || session.send(command))
        .await
        .map_err(|e| format!("omp send task failed: {e}"))?
}

/// Stop the running omp session (stdin EOF, then tree-kill on Windows).
#[tauri::command]
async fn omp_stop(state: tauri::State<'_, OmpState>) -> Result<(), String> {
    if let Some(session) = state.0.lock().map_err(|_| poisoned())?.take() {
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

/// The command macros are module-scoped, so the handler is assembled here
/// where they resolve; lib.rs wires this straight into invoke_handler.
pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        omp_start,
        omp_send,
        omp_stop,
        omp_home,
        omp_list_sessions,
        omp_read_session
    ]
}
