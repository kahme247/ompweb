import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";

export type SkillInfo = {
  name: string;
  description: string;
  dir: string;
  skillPath: string;
  source: string;
  scope: "user" | "project" | string;
  sizeBytes: number;
  updatedAtMs: number;
  disabled: boolean;
};

function relativeTime(ms: number): string {
  if (!ms) return "—";
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Master-detail skills manager (search, toggle, inspect SKILL.md). */
export function SkillsSettings({ cwd, onError }: { cwd: string; onError: (m: string) => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [content, setContent] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = () => {
    invoke<SkillInfo[]>("omp_list_skills", { cwd: cwd.trim() })
      .then((list) => {
        setSkills(list);
        setSelected((prev) => (prev ? (list.find((s) => s.skillPath === prev.skillPath) ?? null) : null));
      })
      .catch(() => setSkills([]));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    setConfirmDelete(false);
    invoke<string>("omp_read_skill", { path: selected.skillPath })
      .then(setContent)
      .catch(() => setContent(""));
  }, [selected]);

  const toggle = async (skill: SkillInfo) => {
    try {
      await invoke("omp_set_skill_disabled", { path: skill.skillPath, disabled: !skill.disabled });
      setSkills((prev) =>
        prev?.map((s) => (s.skillPath === skill.skillPath ? { ...s, disabled: !s.disabled } : s)) ?? prev,
      );
      setSelected((prev) => (prev && prev.skillPath === skill.skillPath ? { ...prev, disabled: !prev.disabled } : prev));
    } catch (err) {
      onError(String(err));
    }
  };

  const remove = async (skill: SkillInfo) => {
    try {
      await invoke("omp_delete_skill", { dir: skill.dir });
      setSelected(null);
      reload();
    } catch (err) {
      onError(String(err));
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills ?? [];
    return (skills ?? []).filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const groups = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    for (const s of filtered ?? []) {
      const label =
        s.scope === "user"
          ? "USER"
          : (s.dir.split(/[\\/]/).filter(Boolean).slice(-3, -1)[0] ?? "PROJECT").toUpperCase();
      const list = map.get(label) ?? [];
      list.push(s);
      map.set(label, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="skills-layout">
      <div className="skills-list-pane">
        <label className="context-menu-search skills-search">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            spellCheck={false}
          />
        </label>
        <div className="skills-list scrollable">
          {skills === null && <div className="context-menu-empty">Loading…</div>}
          {skills !== null && filtered.length === 0 && (
            <div className="context-menu-empty">No skills found</div>
          )}
          {groups.map(([label, list]) => (
            <div key={label}>
              <div className="context-menu-group">
                {label} {list.length}
              </div>
              {list.map((s) => (
                <button
                  key={s.skillPath}
                  className={`skills-row${selected?.skillPath === s.skillPath ? " active" : ""}`}
                  onClick={() => setSelected(s)}
                  title={s.skillPath}
                >
                  <span className="skills-row-name">
                    {s.name}
                    {s.disabled && <span className="skills-disabled-tag">Disabled</span>}
                  </span>
                  <span className="skills-row-desc">{s.description}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        {skills !== null && (
          <div className="skills-list-footer">
            {skills.length} skill{skills.length === 1 ? "" : "s"} · {skills.filter((s) => s.disabled).length} disabled
          </div>
        )}
      </div>

      <div className="skills-detail">
        {!selected ? (
          <div className="settings-empty">Select a skill to inspect it.</div>
        ) : (
          <>
            <div className="skills-detail-head">
              <div className="skills-detail-title">
                <span className="skills-detail-name">{selected.name}</span>
                {selected.disabled && <span className="skills-disabled-tag">Disabled</span>}
                <label className="settings-toggle-wrap" title={selected.disabled ? "Enable" : "Disable"}>
                  <span
                    className={`settings-toggle${selected.disabled ? "" : " on"}`}
                    role="switch"
                    aria-checked={!selected.disabled}
                    onClick={() => void toggle(selected)}
                  >
                    <span className="settings-toggle-knob" />
                  </span>
                </label>
              </div>
              <div className="settings-card-desc">{selected.description}</div>
            </div>
            <div className="skills-meta">
              <div className="skills-meta-row">
                <span>Invoke</span>
                <code>/{selected.name}</code>
              </div>
              <div className="skills-meta-row">
                <span>Location</span>
                <code>{selected.dir}</code>
              </div>
              <div className="skills-meta-row">
                <span>Contents</span>
                <span>{formatSize(selected.sizeBytes)}</span>
              </div>
              <div className="skills-meta-row">
                <span>Updated</span>
                <span>{relativeTime(selected.updatedAtMs)}</span>
              </div>
            </div>
            <div className="skills-actions">
              <button onClick={() => void invoke("omp_reveal_path", { path: selected.skillPath }).catch((e) => onError(String(e)))}>
                <ExternalLink size={12} aria-hidden /> Open SKILL.md
              </button>
              <button onClick={() => void invoke("omp_reveal_path", { path: selected.dir }).catch((e) => onError(String(e)))}>
                <FolderOpen size={12} aria-hidden /> Show in File Manager
              </button>
              <button onClick={() => void invoke("omp_copy_text", { text: selected.dir }).catch((e) => onError(String(e)))}>
                <Copy size={12} aria-hidden /> Copy Path
              </button>
              {confirmDelete ? (
                <button className="danger" onClick={() => void remove(selected)}>
                  Confirm delete
                </button>
              ) : (
                <button className="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={12} aria-hidden /> Delete
                </button>
              )}
            </div>
            <div className="skills-preview">
              <div className="context-menu-group">SKILL.md</div>
              <MarkdownBody cwd={cwd}>{content}</MarkdownBody>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}
