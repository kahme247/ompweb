import { useMemo, useState } from "react";
import { Search } from "lucide-react";

export type SidebarSession = {
  file: string;
  title: string;
  cwd?: string;
  mtimeMs: number;
};

export function projectLabel(cwd: string | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function relativeTime(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function dayGroup(ms: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ms >= startOfToday) return "Today";
  if (ms >= startOfToday - day) return "Yesterday";
  if (ms >= startOfToday - 7 * day) return "Previous 7 days";
  if (ms >= startOfToday - 30 * day) return "Previous 30 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

type SidebarProps = {
  sessions: SidebarSession[];
  activeFile: string | null;
  onOpen: (session: SidebarSession) => void;
};

export function Sidebar({ sessions, activeFile, onOpen }: SidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const groups = useMemo(() => {
    const map = new Map<string, SidebarSession[]>();
    for (const s of filtered) {
      const key = dayGroup(s.mtimeMs);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [filtered]);

  return (
    <>
      <label className="sidebar-search">
        <Search size={14} aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          spellCheck={false}
        />
      </label>
      <nav className="sidebar-sessions">
        {groups.length === 0 && <div className="sidebar-empty">No sessions</div>}
        {groups.map(([group, list]) => (
          <div key={group} className="sidebar-group">
            <div className="sidebar-group-label">{group}</div>
            {list.map((s) => (
              <button
                key={s.file}
                className={`sidebar-session${s.file === activeFile ? " active" : ""}`}
                onClick={() => onOpen(s)}
                title={s.file}
              >
                <span className="sidebar-session-title">{s.title || "(untitled)"}</span>
                <span className="sidebar-session-meta">
                  <span className="sidebar-session-project">{projectLabel(s.cwd)}</span>
                  <span className="sidebar-session-time">{relativeTime(s.mtimeMs)}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
