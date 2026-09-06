import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  Check,
  ChevronRight,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  HardDrive,
  ImagePlus,
  Minimize2,
  Plus,
  Search,
  Settings,
  Wrench,
  X,
  Zap,
} from "lucide-react";

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

type MenuChipProps = {
  chip: ReactNode;
  width?: number;
  children: (close: () => void) => ReactNode;
};

/** Context-row chip that opens a popover anchored above it. */
export function MenuChip({ chip, width = 300, children }: MenuChipProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useOutsideClose(open, close);
  return (
    <span className="context-menu-wrap" ref={ref}>
      <span
        role="button"
        tabIndex={0}
        className={`context-chip menu-chip${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((v) => !v)}
      >
        {chip}
      </span>
      {open && (
        <div className="context-menu" style={{ width }}>
          {children(close)}
        </div>
      )}
    </span>
  );
}

type ProjectInfo = { path: string; name: string; registered: boolean };

export function ProjectMenu({
  cwd,
  home,
  close,
  onPick,
  onError,
}: {
  cwd: string;
  home: string;
  close: () => void;
  onPick: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);

  useEffect(() => {
    invoke<ProjectInfo[]>("omp_list_projects")
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const pick = (path: string) => {
    onPick(path);
    close();
  };

  const addNew = async () => {
    try {
      const folder = await invoke<string | null>("omp_pick_folder");
      if (folder) pick(folder);
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <>
      <div className="context-menu-list">
        {projects === null && <div className="context-menu-empty">Loading…</div>}
        {projects?.map((p) => (
          <button key={p.path} className="context-menu-row" onClick={() => pick(p.path)} title={p.path}>
            <FolderOpen size={13} aria-hidden />
            <span className="context-menu-row-label">{p.name}</span>
            {samePath(p.path, cwd) && <Check size={13} aria-hidden />}
          </button>
        ))}
      </div>
      <div className="context-menu-sep" />
      <button className="context-menu-row" onClick={() => void addNew()}>
        <Plus size={13} aria-hidden />
        <span className="context-menu-row-label">New project…</span>
      </button>
      <button className="context-menu-row" onClick={() => pick(home)}>
        <X size={13} aria-hidden />
        <span className="context-menu-row-label">Don&apos;t work in a project</span>
      </button>
    </>
  );
}

export function BranchMenu({
  cwd,
  project,
  close,
  onDone,
  onError,
}: {
  cwd: string;
  project: string;
  close: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [current, setCurrent] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    invoke<{ current: string; branches: string[] }>("omp_git_branches", { cwd })
      .then((res) => {
        setBranches(res.branches);
        setCurrent(res.current);
      })
      .catch((err) => onError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const checkout = async (branch: string, create: boolean) => {
    try {
      await invoke("omp_git_checkout", { cwd, branch, create });
      close();
      onDone();
    } catch (err) {
      onError(String(err));
    }
  };

  const filtered = (branches ?? []).filter((b) => b.toLowerCase().includes(query.trim().toLowerCase()));
  const exactExists = (branches ?? []).some((b) => b === query.trim());

  return (
    <>
      <label className="context-menu-search">
        <Search size={13} aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim() && !exactExists) {
              void checkout(query.trim(), true);
            }
          }}
          placeholder={`Search ${project || "repo"} branches`}
          spellCheck={false}
        />
      </label>
      <div className="context-menu-list scrollable">
        <div className="context-menu-group">Branches</div>
        {branches === null && <div className="context-menu-empty">Loading…</div>}
        {filtered.map((b) => (
          <button key={b} className="context-menu-row" onClick={() => void checkout(b, false)}>
            <GitBranch size={13} aria-hidden />
            <span className="context-menu-row-label mono">{b}</span>
            {b === current && <Check size={13} aria-hidden />}
          </button>
        ))}
        {branches !== null && filtered.length === 0 && (
          <div className="context-menu-empty">No branches match</div>
        )}
      </div>
      {query.trim() && !exactExists && (
        <>
          <div className="context-menu-sep" />
          <button className="context-menu-row" onClick={() => void checkout(query.trim(), true)}>
            <GitBranchPlus size={13} aria-hidden />
            <span className="context-menu-row-label">Create and checkout &quot;{query.trim()}&quot;</span>
          </button>
        </>
      )}
    </>
  );
}

type WorktreeInfo = { path: string; branch: string; name: string };

export function WorktreeMenu({
  cwd,
  close,
  onPick,
  onError,
}: {
  cwd: string;
  close: () => void;
  onPick: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");

  useEffect(() => {
    invoke<WorktreeInfo[]>("omp_list_worktrees", { cwd })
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [cwd]);

  const create = async () => {
    const branch = newBranch.trim();
    if (!branch) return;
    try {
      const path = await invoke<string>("omp_new_worktree", { cwd, branch });
      setCreating(false);
      setNewBranch("");
      onPick(path);
      close();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <>
      <div className="context-menu-group">Work in</div>
      <div className="context-menu-list scrollable">
        {worktrees === null && <div className="context-menu-empty">Loading…</div>}
        {worktrees?.map((w) => (
          <button key={w.path} className="context-menu-row" onClick={() => { onPick(w.path); close(); }} title={w.path}>
            <HardDrive size={13} aria-hidden />
            <span className="context-menu-row-label">
              {w.name}
              {w.branch ? ` · ${w.branch}` : ""}
            </span>
            {samePath(w.path, cwd) && <Check size={13} aria-hidden />}
          </button>
        ))}
        {worktrees !== null && worktrees.length === 0 && (
          <div className="context-menu-empty">Not a git repository</div>
        )}
      </div>
      <div className="context-menu-sep" />
      {!creating ? (
        <button className="context-menu-row" onClick={() => setCreating(true)}>
          <GitBranchPlus size={13} aria-hidden />
          <span className="context-menu-row-label">New worktree…</span>
        </button>
      ) : (
        <div className="context-menu-inline">
          <input
            autoFocus
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            placeholder="branch name"
            spellCheck={false}
          />
          <button className="context-menu-create" onClick={() => void create()}>Create</button>
          <button className="context-menu-create cancel" onClick={() => setCreating(false)}>
            <X size={12} aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}

// ---------- "+" composer menu (with Tools submenu) ----------

export type ToolPreset = "none" | "default" | "full";

const TOOL_PRESET_LABELS: Record<ToolPreset, string> = {
  none: "No tools",
  default: "Core tools",
  full: "Full tools",
};

type PlusMenuProps = {
  close: () => void;
  running: boolean;
  ready: boolean;
  started: boolean;
  compacting: boolean;
  fastModeEnabled: boolean;
  fastModeSupported: boolean;
  toolPreset: ToolPreset;
  onAttach: () => void;
  onToggleFast: () => void;
  onToolPreset: (preset: ToolPreset) => void;
  onCompact: () => void;
  onManageModels: () => void;
};

export function PlusMenu({
  close,
  running,
  ready,
  started,
  compacting,
  fastModeEnabled,
  fastModeSupported,
  toolPreset,
  onAttach,
  onToggleFast,
  onToolPreset,
  onCompact,
  onManageModels,
}: PlusMenuProps) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <>
      <button
        className="context-menu-row"
        onClick={() => {
          onAttach();
          close();
        }}
      >
        <ImagePlus size={13} aria-hidden />
        <span className="context-menu-row-label">Attach image…</span>
      </button>
      {(fastModeEnabled || (fastModeSupported && started)) && (
        <button
          className="context-menu-row"
          onClick={() => {
            onToggleFast();
            close();
          }}
        >
          <Zap size={13} aria-hidden />
          <span className="context-menu-row-label">Fast mode</span>
          {fastModeEnabled && <Check size={13} aria-hidden />}
        </button>
      )}
      <div
        className="submenu-wrap"
        onMouseEnter={() => setToolsOpen(true)}
        onMouseLeave={() => setToolsOpen(false)}
      >
        <button
          className="context-menu-row"
          onClick={() => setToolsOpen((v) => !v)}
          aria-expanded={toolsOpen}
        >
          <Wrench size={13} aria-hidden />
          <span className="context-menu-row-label">Tools — next session</span>
          <ChevronRight size={12} aria-hidden />
        </button>
        {toolsOpen && (
          <div className="context-submenu">
            {(Object.keys(TOOL_PRESET_LABELS) as ToolPreset[]).map((preset) => (
              <button
                key={preset}
                className="context-menu-row"
                onClick={() => {
                  onToolPreset(preset);
                  close();
                }}
              >
                <span className="context-menu-row-label">{TOOL_PRESET_LABELS[preset]}</span>
                {toolPreset === preset && <Check size={13} aria-hidden />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="context-menu-sep" />
      <button
        className="context-menu-row"
        onClick={() => {
          onCompact();
          close();
        }}
        disabled={running || compacting || !ready}
      >
        <Minimize2 size={13} aria-hidden />
        <span className="context-menu-row-label">
          {compacting ? "Compacting…" : "Compact context"}
        </span>
      </button>
      <button
        className="context-menu-row"
        onClick={() => {
          onManageModels();
          close();
        }}
      >
        <Settings size={13} aria-hidden />
        <span className="context-menu-row-label">Manage models</span>
      </button>
    </>
  );
}
