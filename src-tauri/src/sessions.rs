//! Read-only access to omp session `.jsonl` files under
//! `~/.omp/agent/sessions/<encoded-cwd>/`. Mirrors the leaf-chain semantics of
//! `lib/session-reader.ts` `buildSessionContext()` (leaf→root walk with cycle
//! guard + firstKeptEntryId compaction collapsing) so resumed transcripts show
//! the same view omp-web renders. UI conversion stays minimal: message entries
//! pass through raw (the frontend applies normalizeToolCalls), compactions map
//! to the custom/compaction message MessageView already renders.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SESSIONS_LISTED: usize = 200;
/// Refuse absurd files; a real transcript can reach tens of MB with images.
const MAX_SESSION_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn sessions_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    Ok(Path::new(&home).join(".omp").join("agent").join("sessions"))
}

/// Header info from the fixed 256-byte title slot + the `session` line.
/// Old pi files may lack the title slot — the session line is then line 1.
fn read_session_header(path: &Path) -> Option<(String, Value)> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let parsed: Value = serde_json::from_str(first.trim()).ok()?;
    if parsed["type"] == *"title" {
        let mut second = String::new();
        reader.read_line(&mut second).ok()?;
        let session: Value = serde_json::from_str(second.trim()).ok()?;
        Some((parsed["title"].as_str().unwrap_or("").to_string(), session))
    } else if parsed["type"] == *"session" {
        Some((String::new(), parsed))
    } else {
        None
    }
}

/// Recent sessions across all project dirs, newest first (mtime).
pub fn list_sessions() -> Result<Vec<Value>, String> {
    let root = sessions_root()?;
    let archived = archived_paths();
    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    let dirs = fs::read_dir(&root).map_err(|e| format!("cannot read sessions dir: {e}"))?;
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let file_str = path.to_string_lossy().to_string();
            if archived.iter().any(|p| p.eq_ignore_ascii_case(&file_str)) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() == 0 || meta.len() > MAX_SESSION_FILE_BYTES {
                continue;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            let Some((title, session)) = read_session_header(&path) else { continue };
            if session["type"] != *"session" {
                continue;
            }
            let mtime_ms = mtime
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push((
                mtime,
                json!({
                    "file": path.to_string_lossy(),
                    "title": title,
                    "sessionId": session["id"],
                    "cwd": session["cwd"],
                    "timestamp": session["timestamp"],
                    "mtimeMs": mtime_ms,
                }),
            ));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().take(MAX_SESSIONS_LISTED).map(|(_, v)| v).collect())
}

struct Entry {
    id: String,
    parent: Option<String>,
    kind: String,
    value: Value,
}

fn parse_entries(path: &Path) -> Result<Vec<Entry>, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open session file: {e}"))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else { continue };
        let kind = v["type"].as_str().unwrap_or("").to_string();
        if kind.is_empty() {
            continue;
        }
        let id = v["id"].as_str().unwrap_or("").to_string();
        let parent = v["parentId"].as_str().map(|s| s.to_string());
        entries.push(Entry { id, parent, kind, value: v });
    }
    Ok(entries)
}

fn compaction_message(entry: &Value) -> Value {
    json!({
        "role": "custom",
        "customType": "compaction",
        "content": entry["summary"].as_str().unwrap_or(""),
        "display": true,
    })
}

/// The leaf→root path of the entry tree, newest leaf first in file order.
/// Corrupt files can contain parent cycles; the seen-set keeps the walk bounded.
fn leaf_path(entries: &[Entry]) -> Vec<&Entry> {
    let by_id: HashMap<&str, &Entry> = entries
        .iter()
        .filter(|e| !e.id.is_empty())
        .map(|e| (e.id.as_str(), e))
        .collect();
    // Newest leaf = last entry in file order that carries an id (metadata-only
    // tail entries without ids don't participate in the tree).
    let mut current: Option<&Entry> = entries.iter().rev().find(|e| !e.id.is_empty());
    let mut path = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(entry) = current {
        if !seen.insert(entry.id.clone()) {
            break;
        }
        path.push(entry);
        current = entry
            .parent
            .as_deref()
            .and_then(|pid| by_id.get(pid).copied());
    }
    path.reverse();
    path
}

/// Messages displayed for a session's active branch (no leafId → last entry).
/// Same collapsing rule as buildSessionContext: the active compaction summary
/// first, kept entries from firstKeptEntryId onward, then post-compaction.
pub fn read_session(file: &str) -> Result<Vec<Value>, String> {
    let path = Path::new(file);
    // Confine reads to the sessions root — the UI only ever passes back paths
    // from omp_list_sessions, but stay defensive like the omp-web routes.
    let root = sessions_root()?;
    let canonical = path.canonicalize().map_err(|e| format!("cannot resolve session file: {e}"))?;
    let root_canonical = root.canonicalize().map_err(|e| format!("cannot resolve sessions root: {e}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err("session file is outside the sessions directory".to_string());
    }

    let entries = parse_entries(path)?;
    let path_refs = leaf_path(&entries);

    let mut messages = Vec::new();
    let compaction = path_refs.iter().rev().find(|e| e.kind == "compaction").map(|e| e.value.clone());
    let append_message = |entry: &Entry, messages: &mut Vec<Value>| {
        if entry.kind == "message" {
            let message = &entry.value["message"];
            if message.is_object() {
                messages.push(message.clone());
            }
        }
    };

    match compaction {
        Some(active) => {
            messages.push(compaction_message(&active));
            let compaction_idx = path_refs
                .iter()
                .position(|e| e.kind == "compaction" && e.value == active)
                .unwrap_or(0);
            let first_kept = active["firstKeptEntryId"].as_str().unwrap_or("");
            let mut found_first_kept = first_kept.is_empty();
            for entry in &path_refs[..compaction_idx] {
                if !found_first_kept && entry.id == first_kept {
                    found_first_kept = true;
                }
                if found_first_kept {
                    append_message(entry, &mut messages);
                }
            }
            for entry in path_refs.iter().skip(compaction_idx + 1) {
                append_message(entry, &mut messages);
            }
        }
        None => {
            for entry in &path_refs {
                append_message(entry, &mut messages);
            }
        }
    }
    Ok(messages)
}

/// Stream a session file and sum assistant-message usage (tokens, cost).
/// Lighter than read_session — no tree/compaction handling; usage blocks only.
pub fn session_usage_totals(file: &Path) -> Option<(u64, f64)> {
    use std::io::BufRead;
    let reader = std::io::BufReader::new(std::fs::File::open(file).ok()?);
    let mut tokens: u64 = 0;
    let mut cost: f64 = 0.0;
    let mut any = false;
    for line in reader.lines().flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v["type"] != *"message" {
            continue;
        }
        let msg = &v["message"];
        if msg["role"] != *"assistant" {
            continue;
        }
        if let Some(usage) = msg.get("usage") {
            any = true;
            tokens += usage["totalTokens"].as_u64().unwrap_or(0);
            cost += usage["cost"]["total"].as_f64().unwrap_or(0.0);
        }
    }
    if any {
        Some((tokens, cost))
    } else {
        None
    }
}

/// Per-session token/cost totals for the 30 most recent sessions that carry
/// usage blocks — backs the Usage settings page.
pub fn usage_history() -> Result<Vec<serde_json::Value>, String> {
    let files = list_sessions()?;
    let mut out = Vec::new();
    for session in files.iter().take(30) {
        let Some(file) = session["file"].as_str() else {
            continue;
        };
        if let Some((tokens, cost)) = session_usage_totals(std::path::Path::new(file)) {
            out.push(serde_json::json!({
                "title": session["title"],
                "cwd": session["cwd"],
                "mtimeMs": session["mtimeMs"],
                "tokens": tokens,
                "cost": cost,
            }));
        }
    }
    Ok(out)
}

// ---------- Session management (rename / delete / archive) ----------

/// Confine a caller-supplied path to the sessions root.
fn confine_session_path(file: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(sessions_root()?).map_err(|e| e.to_string())?;
    let target = fs::canonicalize(file).map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("path is outside the sessions root".into());
    }
    Ok(target)
}

fn archive_file() -> PathBuf {
    // Companion to the sessions dir; omp ignores unknown files here.
    sessions_root()
        .unwrap_or_else(|_| PathBuf::from("."))
        .parent()
        .map(|p| p.join("ompweb-desktop.json"))
        .unwrap_or_else(|| PathBuf::from("ompweb-desktop.json"))
}

fn archived_paths() -> Vec<String> {
    std::fs::read_to_string(archive_file())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v["archived"].as_array().cloned())
        .map(|a| {
            a.into_iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn write_archived_paths(list: &[String]) -> Result<(), String> {
    let path = archive_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&json!({ "archived": list })).map_err(|e| e.to_string())?;
    std::fs::write(path, serialized).map_err(|e| e.to_string())
}

/// Rewrite the fixed 256-byte title slot in place (file length unchanged).
pub fn rename_session(file: &str, title: &str) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let target = confine_session_path(file)?;
    let mut title = title.trim().to_string();
    if title.is_empty() {
        return Err("title must not be empty".into());
    }
    let mut f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    let mut slot = [0u8; 256];
    f.read_exact(&mut slot).map_err(|e| format!("not a v3 session file: {e}"))?;
    let mut header: Value = serde_json::from_slice(&slot)
        .map_err(|_| "session has no rewriteable title slot (legacy format)".to_string())?;
    if header["type"] != *"title" {
        return Err("session has no rewriteable title slot (legacy format)".into());
    }
    header["title"] = json!(title);
    header["updatedAt"] = json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    );
    // Shrink the title until the serialized header fits the 256-byte slot.
    let mut line;
    loop {
        line = serde_json::to_string(&header).map_err(|e| e.to_string())?;
        if line.len() <= 256 {
            break;
        }
        let Some(current) = header["title"].as_str() else {
            return Err("title too long".into());
        };
        if current.chars().count() <= 8 {
            return Err("title too long".into());
        }
        let cut: String = current.chars().take(current.chars().count() - 4).collect();
        header["title"] = json!(cut);
    }
    line.push_str(&" ".repeat(256 - line.len()));
    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_session(file: &str) -> Result<(), String> {
    let target = confine_session_path(file)?;
    fs::remove_file(&target).map_err(|e| e.to_string())?;
    let mut list = archived_paths();
    list.retain(|p| !p.eq_ignore_ascii_case(file));
    write_archived_paths(&list)
}

pub fn set_session_archived(file: &str, archived: bool) -> Result<(), String> {
    confine_session_path(file)?;
    let mut list = archived_paths();
    if archived {
        if !list.iter().any(|p| p.eq_ignore_ascii_case(file)) {
            list.push(file.to_string());
        }
    } else {
        list.retain(|p| !p.eq_ignore_ascii_case(file));
    }
    write_archived_paths(&list)
}

pub fn is_archived(file: &str) -> bool {
    archived_paths().iter().any(|p| p.eq_ignore_ascii_case(file))
}
