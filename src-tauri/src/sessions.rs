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
    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    let dirs = fs::read_dir(&root).map_err(|e| format!("cannot read sessions dir: {e}"))?;
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
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
