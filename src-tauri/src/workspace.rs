//! Composer context menus + Skills settings backing: project registry list,
//! native folder picker, git branches/worktrees, and omp-style skill
//! discovery (mirrors lib/skills-service.ts scan-root priority).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run_git(cwd: &str, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    Some((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
    ))
}

fn agent_dir() -> PathBuf {
    std::env::var("OMP_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_home().join(".omp").join("agent")
        })
}

fn dirs_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn same_dir(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    return a.trim_end_matches(['\\', '/']).to_lowercase() == b.trim_end_matches(['\\', '/']).to_lowercase();
    #[cfg(not(windows))]
    return a.trim_end_matches('/') == b.trim_end_matches('/');
}

/// Registered (non-hidden) projects first, then session-discovered cwds.
#[tauri::command]
pub fn omp_list_projects() -> Result<Vec<Value>, String> {
    let mut projects: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let push = |path: &str, registered: bool, projects: &mut Vec<Value>, seen: &mut Vec<String>| {
        if path.is_empty() || seen.iter().any(|s| same_dir(s, path)) {
            return;
        }
        seen.push(path.to_string());
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        projects.push(json!({ "path": path, "name": name, "registered": registered }));
    };

    let registry = agent_dir().join("projects.json");
    if let Ok(raw) = std::fs::read_to_string(&registry) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            let mut entries: Vec<&Value> = parsed["projects"]
                .as_array()
                .map(|a| a.iter().collect())
                .unwrap_or_default();
            entries.sort_by_key(|e| e["addedAt"].as_str().unwrap_or("").to_string());
            for entry in entries {
                if entry["hidden"].as_bool().unwrap_or(false) {
                    continue;
                }
                if let Some(path) = entry["path"].as_str() {
                    push(path, true, &mut projects, &mut seen);
                }
            }
        }
    }
    if let Ok(sessions) = crate::sessions::list_sessions() {
        for session in sessions.iter().take(200) {
            if let Some(cwd) = session["cwd"].as_str() {
                push(cwd, false, &mut projects, &mut seen);
            }
        }
    }
    Ok(projects)
}

/// Native folder picker (Add-project flow).
#[tauri::command]
pub async fn omp_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Select project folder")
            .blocking_pick_folder();
        Ok(picked.map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("folder picker failed: {e}"))?
}

/// Native image file picker for composer attachments.
#[tauri::command]
pub async fn omp_pick_image(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Attach image")
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_file();
        Ok(picked.map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("file picker failed: {e}"))?
}

/// Reveal ~/.omp/agent/models.yml in File Manager ("Manage models").
#[tauri::command]
pub fn omp_manage_models(app: AppHandle) -> Result<(), String> {
    let path = agent_dir().join("models.yml");
    if !path.is_file() {
        return Err("models.yml does not exist yet".into());
    }
    omp_reveal_path(path.to_string_lossy().to_string())?;
    let _ = app;
    Ok(())
}

/// Branches newest-first with the checked-out one flagged.
#[tauri::command]
pub fn omp_git_branches(cwd: String) -> Result<Value, String> {
    let Some((ok, out)) = run_git(&cwd, &["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"])
    else {
        return Err("git not available".into());
    };
    if !ok {
        return Err("not a git repository".into());
    }
    let current = run_git(&cwd, &["branch", "--show-current"])
        .map(|(_, out)| out.trim().to_string())
        .unwrap_or_default();
    let branches: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    Ok(json!({ "current": current, "branches": branches }))
}

#[tauri::command]
pub fn omp_git_checkout(cwd: String, branch: String, create: bool) -> Result<(), String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch.contains("..") || branch.starts_with('-') {
        return Err("invalid branch name".into());
    }
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", &branch]
    } else {
        vec!["checkout", &branch]
    };
    match run_git(&cwd, &args) {
        Some((true, _)) => Ok(()),
        Some((false, out)) => {
            let err = run_git(&cwd, &args)
                .map(|(_, e)| e)
                .unwrap_or_default();
            let _ = out;
            Err(err.lines().last().unwrap_or("checkout failed").to_string())
        }
        None => Err("git not available".into()),
    }
}

/// `git worktree list --porcelain` → [{path, branch}] (first = main).
#[tauri::command]
pub fn omp_list_worktrees(cwd: String) -> Result<Vec<Value>, String> {
    let Some((ok, out)) = run_git(&cwd, &["worktree", "list", "--porcelain"]) else {
        return Err("git not available".into());
    };
    if !ok {
        return Err("not a git repository".into());
    }
    let mut worktrees: Vec<Value> = Vec::new();
    let mut path = String::new();
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.trim().to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            let branch = b.trim().trim_start_matches("refs/heads/").to_string();
            if !path.is_empty() {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                worktrees.push(json!({ "path": path, "branch": branch, "name": name }));
            }
        }
    }
    Ok(worktrees)
}

/// Create a worktree for `branch` under `<repoRoot>-worktrees/<branch>`,
/// mirroring omp-web's lib/worktree.ts layout. Returns the new path.
#[tauri::command]
pub fn omp_new_worktree(cwd: String, branch: String) -> Result<String, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch.contains("..") || branch.starts_with('-') {
        return Err("invalid branch name".into());
    }
    let Some((true, root)) = run_git(&cwd, &["rev-parse", "--show-toplevel"]) else {
        return Err("not inside a git repository".into());
    };
    let root = root.trim();
    let parent = Path::new(root).parent().unwrap_or(Path::new(root));
    let sanitized: String = branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let target = parent.join(format!("{}-worktrees", Path::new(root).file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    let wt_path = target.join(&sanitized);
    if wt_path.exists() {
        return Err(format!("worktree already exists: {}", wt_path.display()));
    }
    let exists = run_git(&cwd, &["show-ref", "--verify", &format!("refs/heads/{branch}")])
        .map(|(ok, _)| ok)
        .unwrap_or(false);
    let wt = wt_path.to_string_lossy().to_string();
    let args: Vec<&str> = if exists {
        vec!["worktree", "add", &wt, &branch]
    } else {
        vec!["worktree", "add", "-b", &branch, &wt]
    };
    match run_git(&cwd, &args) {
        Some((true, _)) => Ok(wt),
        Some((false, out)) => Err(out.lines().last().unwrap_or("worktree creation failed").to_string()),
        None => Err("git not available".into()),
    }
}

/// Show a path in File Manager (selected).
#[tauri::command]
pub fn omp_reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(format!("/select,{}", path));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("not supported on this platform".into())
    }
}

#[tauri::command]
pub fn omp_copy_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Set-Clipboard", "-Value", &text]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("not supported on this platform".into())
    }
}

/// Read a dropped image file as base64 for the prompt `images` payload.
#[tauri::command]
pub fn omp_read_image(path: String) -> Result<Value, String> {
    const MIME_BY_EXT: &[(&str, &str)] = &[
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
    ];
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some((_, mime)) = MIME_BY_EXT.iter().find(|(e, _)| *e == ext) else {
        return Err(format!("unsupported image type: .{ext}"));
    };
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("image exceeds 8 MB".into());
    }
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({ "data": data, "mimeType": mime }))
}

// ---------- Native omp settings (~/.omp/agent/config.yml) ----------
// Mirror of lib/omp/settings-config.ts's allow-list. NOTE: writes rewrite the
// YAML document, so hand-written comments in config.yml do not survive a
// save (serde_yaml cannot preserve them).

const SETTING_ENUMS: &[(&str, &[&str])] = &[
    ("defaultThinkingLevel", &["auto", "minimal", "low", "medium", "high", "xhigh", "max"]),
    ("textVerbosity", &["low", "medium", "high"]),
    ("personality", &["default", "friendly", "pragmatic", "none"]),
    ("tools.approvalMode", &["always-ask", "write", "yolo"]),
    ("tools.approval.bash", &["allow", "prompt", "deny"]),
    ("tools.approval.extension", &["allow", "prompt"]),
    ("compaction.strategy", &["snapcompact", "handoff", "context-full", "shake", "off"]),
    ("memory.backend", &["off", "local", "mnemopi", "hindsight"]),
    ("advisor.syncBacklog", &["off", "1", "3", "5"]),
];
const SETTING_BOOLS: &[&str] = &[
    "hideThinkingBlock",
    "externalThinking",
    "retry.enabled",
    "retry.modelFallback",
    "compaction.enabled",
    "compaction.midTurnEnabled",
    "compaction.autoContinue",
    "compaction.remoteEnabled",
    "autolearn.enabled",
    "autolearn.autoContinue",
    "mcp.enableProjectConfig",
    "mcp.renderMarkdownResults",
    "mcp.notifications",
    "advisor.enabled",
    "advisor.subagents",
];
const SETTING_NUMBERS: &[&str] = &[
    "retry.maxRetries",
    "compaction.keepRecentTokens",
    "autolearn.minToolCalls",
    "mcp.notificationDebounceMs",
    "advisor.immuneTurns",
];

fn validate_setting(path: &str, value: &Value) -> Result<(), String> {
    if let Some((_, allowed)) = SETTING_ENUMS.iter().find(|(p, _)| *p == path) {
        match value {
            Value::Null => Ok(()),
            Value::String(s) if allowed.contains(&s.as_str()) => Ok(()),
            _ => Err(format!("{path} must be one of: {}", allowed.join(", "))),
        }
    } else if SETTING_BOOLS.contains(&path) {
        match value {
            Value::Null | Value::Bool(_) => Ok(()),
            _ => Err(format!("{path} must be a boolean")),
        }
    } else if SETTING_NUMBERS.contains(&path) {
        match value {
            Value::Null | Value::Number(_) => Ok(()),
            _ => Err(format!("{path} must be a number")),
        }
    } else {
        Err(format!("setting not editable here: {path}"))
    }
}

fn config_yaml() -> serde_yaml::Value {
    let path = agent_dir().join("config.yml");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_yaml::from_str(&raw).ok())
        .unwrap_or_else(|| serde_yaml::Value::Mapping(Default::default()))
}

fn yaml_get<'a>(root: &'a serde_yaml::Value, path: &str) -> Option<&'a serde_yaml::Value> {
    let mut current = root;
    for key in path.split('.') {
        current = current.get(key)?;
    }
    Some(current)
}

fn yaml_set(root: &mut serde_yaml::Value, path: &str, value: serde_yaml::Value) {
    let mut current = root;
    let keys: Vec<&str> = path.split('.').collect();
    for (i, key) in keys.iter().enumerate() {
        let last = i == keys.len() - 1;
        if last {
            if let Some(map) = current.as_mapping_mut() {
                if value.is_null() {
                    map.remove(serde_yaml::Value::String((*key).to_string()));
                } else {
                    map.insert(serde_yaml::Value::String((*key).to_string()), value);
                }
            }
            return;
        }
        let next = current.get_mut(key);
        if next.is_none() {
            if let Some(map) = current.as_mapping_mut() {
                map.insert(
                    serde_yaml::Value::String((*key).to_string()),
                    serde_yaml::Value::Mapping(Default::default()),
                );
            }
        }
        current = current.get_mut(key).expect("just inserted");
        if !current.is_mapping() {
            *current = serde_yaml::Value::Mapping(Default::default());
        }
    }
}

fn yaml_to_json(value: &serde_yaml::Value) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The editable subset of ~/.omp/agent/config.yml (allow-listed paths only).
#[tauri::command]
pub fn omp_get_native_settings() -> Result<Value, String> {
    let doc = config_yaml();
    let mut out = serde_json::Map::new();
    let mut put = |map: &mut serde_json::Map<String, Value>, path: &str, value: Value| {
        let mut current = map;
        let keys: Vec<&str> = path.split('.').collect();
        for key in &keys[..keys.len() - 1] {
            let entry = current
                .entry((*key).to_string())
                .or_insert_with(|| json!({}));
            if !entry.is_object() {
                *entry = json!({});
            }
            current = entry.as_object_mut().expect("just made object");
        }
        current.insert(keys[keys.len() - 1].to_string(), value);
    };
    for (path, _) in SETTING_ENUMS {
        if let Some(v) = yaml_get(&doc, path) {
            if !v.is_null() {
                put(&mut out, path, yaml_to_json(v));
            }
        }
    }
    for path in SETTING_BOOLS {
        if let Some(v) = yaml_get(&doc, path) {
            if let Some(b) = v.as_bool() {
                put(&mut out, path, json!(b));
            }
        }
    }
    for path in SETTING_NUMBERS {
        if let Some(v) = yaml_get(&doc, path) {
            if let Some(n) = v.as_i64() {
                put(&mut out, path, json!(n));
            }
        }
    }
    Ok(Value::Object(out))
}

/// Set one allow-listed setting; Value::Null removes the key (omp default).
#[tauri::command]
pub fn omp_set_native_setting(path: String, value: Value) -> Result<(), String> {
    validate_setting(&path, &value)?;
    let mut doc = config_yaml();
    if !doc.is_mapping() {
        doc = serde_yaml::Value::Mapping(Default::default());
    }
    let yaml_value = if value.is_null() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::to_value(&value).map_err(|e| e.to_string())?
    };
    yaml_set(&mut doc, &path, yaml_value);
    let serialized = serde_yaml::to_string(&doc).map_err(|e| e.to_string())?;
    let target = agent_dir().join("config.yml");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("yml.tmp");
    std::fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

// ---------- Skills ----------

fn frontmatter(content: &str) -> (String, String) {
    // Returns (frontmatter, body). Only the leading `---` fenced block.
    let rest = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n"));
    if let Some(rest) = rest {
        if let Some(end) = rest.find("\n---").or_else(|| rest.find("\r\n---")) {
            return (rest[..end].to_string(), rest[end..].trim_start_matches("---\n").trim_start_matches("---\r\n").to_string());
        }
    }
    (String::new(), content.to_string())
}

fn fm_value(fm: &str, key: &str) -> Option<String> {
    for line in fm.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(&format!("{key}:")) {
            let value = rest.trim().trim_matches(['"', '\'']).to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn is_disabled(fm: &str) -> bool {
    for key in ["disable-model-invocation", "disableModelInvocation", "hide"] {
        if let Some(v) = fm_value(fm, key) {
            if v == "true" {
                return true;
            }
        }
    }
    false
}

fn skill_info(dir: &Path, source: &str, scope: &str) -> Option<Value> {
    let skill_path = dir.join("SKILL.md");
    let content = std::fs::read_to_string(&skill_path).ok()?;
    let (fm, _body) = frontmatter(&content);
    let name = fm_value(&fm, "name")
        .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let description = fm_value(&fm, "description").unwrap_or_default();
    if description.is_empty() {
        return None;
    }
    let meta = std::fs::metadata(&skill_path).ok();
    Some(json!({
        "name": name,
        "description": description,
        "dir": dir.to_string_lossy(),
        "skillPath": skill_path.to_string_lossy(),
        "source": source,
        "scope": scope,
        "sizeBytes": meta.as_ref().map(|m| m.len()).unwrap_or(0),
        "updatedAtMs": meta.as_ref().and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "disabled": is_disabled(&fm),
    }))
}

fn push_unique(skills: &mut Vec<Value>, seen: &mut Vec<PathBuf>, dir: &Path, source: &str, scope: &str) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                continue;
            }
            if seen.iter().any(|s| s == &path) {
                continue;
            }
            if let Some(info) = skill_info(&path, source, scope) {
                seen.push(path);
                skills.push(info);
            }
        }
    }
}

/// omp-priority skill scan: .omp → .claude → .agent(s)/.codex → .github →
/// managed. Project = ancestors of cwd up to the repo root (closest first).
#[tauri::command]
pub fn omp_list_skills(cwd: String) -> Result<Vec<Value>, String> {
    let home = dirs_home();
    // ancestors of cwd, closest first, stopping at the repo root / home.
    let mut ancestors: Vec<PathBuf> = Vec::new();
    let mut current = PathBuf::from(cwd.trim());
    if current.as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    loop {
        ancestors.push(current.clone());
        if current.join(".git").exists() || current == home {
            break;
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    let project_ancestors: Vec<&PathBuf> = ancestors.iter().filter(|d| **d != home).collect();

    let mut skills: Vec<Value> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();

    for dir in &project_ancestors {
        push_unique(&mut skills, &mut seen, &dir.join(".omp").join("skills"), ".omp", "project");
    }
    push_unique(&mut skills, &mut seen, &agent_dir().join("skills"), ".omp", "user");
    push_unique(&mut skills, &mut seen, &home.join(".claude").join("skills"), ".claude", "user");
    for dir in &project_ancestors {
        push_unique(&mut skills, &mut seen, &dir.join(".claude").join("skills"), ".claude", "project");
    }
    for dir in &project_ancestors {
        push_unique(&mut skills, &mut seen, &dir.join(".agent").join("skills"), ".agents", "project");
        push_unique(&mut skills, &mut seen, &dir.join(".agents").join("skills"), ".agents", "project");
    }
    push_unique(&mut skills, &mut seen, &home.join(".agent").join("skills"), ".agents", "user");
    push_unique(&mut skills, &mut seen, &home.join(".agents").join("skills"), ".agents", "user");
    push_unique(&mut skills, &mut seen, &home.join(".codex").join("skills"), ".codex", "user");
    push_unique(&mut skills, &mut seen, &PathBuf::from(&cwd).join(".codex").join("skills"), ".codex", "project");
    if let Some(root) = ancestors.last() {
        push_unique(&mut skills, &mut seen, &root.join(".github").join("skills"), ".github", "project");
    }
    push_unique(&mut skills, &mut seen, &agent_dir().join("managed-skills"), "managed", "user");

    Ok(skills)
}

/// Read a SKILL.md the scanner listed (confined to the user profile).
#[tauri::command]
pub fn omp_read_skill(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.file_name().map(|n| n != "SKILL.md").unwrap_or(true) {
        return Err("not a SKILL.md path".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Toggle `disable-model-invocation` in a SKILL.md's frontmatter, preserving
/// the rest of the file (mirrors omp-web's surgical edit).
#[tauri::command]
pub fn omp_set_skill_disabled(path: String, disabled: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let (fm, body) = frontmatter(&content);
    let lines: Vec<String> = fm
        .lines()
        .map(|l| l.to_string())
        .filter(|l| {
            !l.trim_start().starts_with("disable-model-invocation:")
                && !l.trim_start().starts_with("disableModelInvocation:")
                && !l.trim_start().starts_with("hide:")
        })
        .collect();
    let mut next = String::new();
    if !fm.is_empty() {
        next.push_str("---\n");
        for line in &lines {
            next.push_str(line);
            next.push('\n');
        }
        if disabled {
            next.push_str("disable-model-invocation: true\n");
        }
        next.push_str("---\n");
    } else if disabled {
        next.push_str("---\ndisable-model-invocation: true\n---\n");
    }
    next.push_str(&body);
    std::fs::write(&p, next).map_err(|e| e.to_string())
}

/// Delete a skill directory (must contain SKILL.md).
#[tauri::command]
pub fn omp_delete_skill(dir: String) -> Result<(), String> {
    let d = PathBuf::from(&dir);
    if !d.join("SKILL.md").is_file() {
        return Err("refusing to delete: no SKILL.md inside".into());
    }
    std::fs::remove_dir_all(&d).map_err(|e| e.to_string())
}

// ---------- Git changes + file explorer ----------

fn repo_root(cwd: &str) -> Result<PathBuf, String> {
    match run_git(cwd, &["rev-parse", "--show-toplevel"]) {
        Some((true, out)) => {
            let root = out.trim().to_string();
            if root.is_empty() {
                Err("not a git repository".into())
            } else {
                Ok(PathBuf::from(root))
            }
        }
        Some((false, _)) => Err("not a git repository".into()),
        None => Err("git not available".into()),
    }
}

/// Confine a repo-relative path: no absolutes, no `..` escapes.
fn confine_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(path);
    if rel.is_absolute() || path.contains("..") {
        return Err("path escapes the repository".into());
    }
    Ok(root.join(rel))
}

fn parse_ahead_behind(header: &str) -> (u32, u32) {
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(bracket) = header.split('[').nth(1).and_then(|s| s.split(']').next()) {
        for part in bracket.split(',') {
            let part = part.trim();
            if let Some(n) = part.strip_prefix("ahead ").and_then(|n| n.parse().ok()) {
                ahead = n;
            }
            if let Some(n) = part.strip_prefix("behind ").and_then(|n| n.parse().ok()) {
                behind = n;
            }
        }
    }
    (ahead, behind)
}

/// `git status --porcelain=v1 -b` → { branch, ahead, behind, files: [{ path, index, worktree }] }.
/// Rename entries resolve to the new path.
#[tauri::command]
pub fn omp_git_status(cwd: String) -> Result<Value, String> {
    let Some((ok, out)) = run_git(&cwd, &["status", "--porcelain=v1", "-b"]) else {
        return Err("git not available".into());
    };
    if !ok {
        return Err("not a git repository".into());
    }
    let mut lines = out.lines();
    let header = lines.next().unwrap_or("");
    let head = header.strip_prefix("## ").unwrap_or(header);
    let head = head.strip_prefix("No commits yet on ").unwrap_or(head);
    let branch = head.split("...").next().unwrap_or(head).to_string();
    let (ahead, behind) = parse_ahead_behind(head);
    let mut files = Vec::new();
    for line in lines {
        if line.len() < 4 {
            continue;
        }
        let index = line.chars().next().unwrap_or(' ');
        let worktree = line.chars().nth(1).unwrap_or(' ');
        let mut path = line[3..].trim().to_string();
        // Rename/copy entries: `R  old -> new`.
        if let Some(arrow) = path.find(" -> ") {
            path = path[arrow + 4..].to_string();
        }
        // Porcelain quotes paths with special bytes: `"a b"`.
        if path.len() >= 2 && path.starts_with('"') && path.ends_with('"') {
            path = path[1..path.len() - 1].to_string();
        }
        if path.is_empty() || (index == ' ' && worktree == ' ') {
            continue;
        }
        files.push(json!({ "path": path, "index": index.to_string(), "worktree": worktree.to_string() }));
    }
    Ok(json!({ "branch": branch, "ahead": ahead, "behind": behind, "files": files }))
}
/// Unified diff for one file. `staged = true` diffs the index, else the worktree.
#[tauri::command]
pub fn omp_git_file_diff(cwd: String, path: String, staged: bool) -> Result<Value, String> {
    let root = repo_root(&cwd)?;
    confine_path(&root, &path)?;
    let args: Vec<&str> = if staged {
        vec!["diff", "--no-color", "--cached", "--", &path]
    } else {
        vec!["diff", "--no-color", "--", &path]
    };
    match run_git(&cwd, &args) {
        Some((_, out)) => Ok(json!({ "diff": out })),
        None => Err("git not available".into()),
    }
}

const LIST_SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "build", ".venv", "__pycache__", ".turbo", ".parcel-cache"];
const LIST_MAX_ENTRIES: usize = 5000;

/// Capped recursive listing, repo-relative `/`-separated paths.
/// Skips dependency/build dirs. → { root, entries: [{ path, dir }], truncated }.
#[tauri::command]
pub fn omp_list_files(cwd: String) -> Result<Value, String> {
    let root = repo_root(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
    let mut entries: Vec<Value> = Vec::new();
    let mut stack = vec![PathBuf::new()];
    let mut truncated = false;
    while let Some(rel) = stack.pop() {
        let abs = root.join(&rel);
        let read = match std::fs::read_dir(&abs) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut children: Vec<(String, bool)> = Vec::new();
        for child in read.flatten() {
            let name = child.file_name().to_string_lossy().to_string();
            let is_dir = child.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && LIST_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            children.push((name, is_dir));
        }
        children.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (name, is_dir) in children.into_iter().rev() {
            if entries.len() >= LIST_MAX_ENTRIES {
                truncated = true;
                break;
            }
            let child_rel = if rel.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                rel.join(&name)
            };
            entries.push(json!({
                "path": child_rel.to_string_lossy().replace('\\', "/"),
                "dir": is_dir,
            }));
            if is_dir {
                stack.push(child_rel);
            }
        }
        if truncated {
            break;
        }
    }
    Ok(json!({ "root": root.to_string_lossy(), "entries": entries, "truncated": truncated }))
}

const READ_MAX_BYTES: u64 = 256 * 1024;

/// Read a repo-confined text file. → { content, truncated }. Refuses binaries.
#[tauri::command]
pub fn omp_read_file(cwd: String, path: String) -> Result<Value, String> {
    let root = repo_root(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
    let abs = confine_path(&root, &path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file too large".into());
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let truncated = bytes.len() as u64 > READ_MAX_BYTES;
    let slice = if truncated { &bytes[..READ_MAX_BYTES as usize] } else { &bytes[..] };
    match String::from_utf8(slice.to_vec()) {
        Ok(content) => Ok(json!({ "content": content, "truncated": truncated })),
        Err(_) => Err("binary file".into()),
    }
}
