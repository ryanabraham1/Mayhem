import { useEffect, useState } from "react";
import { ArrowUp, Folder, FolderOpen, FolderPlus, X } from "lucide-react";
import { backend, isTauri } from "../backend";
import { recentProjects, useStore } from "../store";
import { checkForUpdate, useUpdater } from "../updater";

export async function pickFolder(title: string): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ directory: true, multiple: false, title });
    return typeof res === "string" ? res : null;
  }
  return new Promise((resolve) => {
    folderPickerResolve.current = resolve;
    openListeners.forEach((fn) => fn());
  });
}

const joinPath = (dir: string, name: string) => {
  const sep = /^[a-z]:|^\\\\/i.test(dir) ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
};

// Browser-mode folder picker (the Tauri build uses the native dialog).
const folderPickerResolve: { current: ((v: string | null) => void) | null } = { current: null };
const openListeners = new Set<() => void>();

export function FolderPickerModal() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<{ path: string; parent: string; entries: { name: string; path: string; dir: boolean }[] } | null>(null);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setNewName("");
      backend.call<string>("homeDir").then(load).catch(() => {});
    };
    openListeners.add(onOpen);
    return () => { openListeners.delete(onOpen); };
  }, []);

  const load = (p: string) => {
    backend.call("listDir", { path: p }).then((l: any) => { setListing(l); setPath(l.path); }).catch(() => {});
  };
  const close = (v: string | null) => {
    folderPickerResolve.current?.(v);
    folderPickerResolve.current = null;
    setOpen(false);
  };
  if (!open) return null;
  return (
    <div className="modal-back" onClick={() => close(null)}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">Choose a folder</div>
          <button className="btn sm icon" onClick={() => close(null)}><X size={14} /></button>
        </div>
        <div className="card-body form">
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn icon" onClick={() => listing && load(listing.parent)} title="Up"><ArrowUp size={16} /></button>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(path)} />
          </div>
          <div className="browser">
            {listing?.entries.filter((e) => e.dir).map((e) => (
              <div key={e.path} className="item" onClick={() => load(e.path)}>
                <span className="icon"><Folder size={15} /></span><span className="name">{e.name}</span>
              </div>
            ))}
            {listing && !listing.entries.some((e) => e.dir) && <div className="sidebar-empty" style={{ paddingTop: 10 }}>No subfolders</div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="New folder name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn primary" onClick={() => close(newName ? joinPath(path, newName) : path)}>Choose</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Welcome() {
  const fields = useStore((s) => s.fields);
  const status = useStore((s) => s.backendStatus);
  const a = useStore.getState();
  const [recents, setRecents] = useState<string[]>([]);
  useEffect(() => setRecents(recentProjects()), []);

  const create = async (dir?: string | null) => {
    const d = dir ?? (await pickFolder("Choose a folder for the new project (e.g. src/main/deploy/mayhem)"));
    if (!d) return;
    try {
      await a.createProject(d, fields.find((f) => f.id === "rebuilt-2026"));
    } catch (e: any) {
      a.toast("error", e.message);
    }
  };
  const open = async (dir?: string | null) => {
    const d = dir ?? (await pickFolder("Open a Mayhem project folder"));
    if (!d) return;
    try {
      await a.openProject(d);
    } catch (e: any) {
      if (/No project\.mayhem/.test(e.message) && window.confirm(`${d} is not a Mayhem project yet. Create one there?`)) await create(d);
      else a.toast("error", e.message);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-head">
          <div className="logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M8.2 18H14a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h5.8" />
            </svg>
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>Mayhem</div>
            <div className="muted" style={{ fontSize: 13 }}>Swerve trajectory planner · 2026 REBUILT</div>
          </div>
        </div>
        {status !== "ready" && (
          <div className="note" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`dot ${status === "down" ? "bad" : "warn"}`} />
            {status === "down"
              ? <span>Can't reach the solver. For browser dev, run <span className="mono">uv run mayhem-solver serve --ws 8765</span> in <span className="mono">solver/</span>.</span>
              : "Starting the solver…"}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" style={{ flex: 1, justifyContent: "center", height: 36 }} disabled={status !== "ready"} onClick={() => void create()}>
            <FolderPlus size={16} /> New project
          </button>
          <button className="btn" style={{ flex: 1, justifyContent: "center", height: 36 }} disabled={status !== "ready"} onClick={() => void open()}>
            <FolderOpen size={16} /> Open project
          </button>
        </div>
        <div className="note">Tip: keep the project in your robot code's <span className="mono">src/main/deploy/mayhem</span> folder, so saving a path deploys it.</div>
        {recents.length > 0 && (
          <div>
            <div className="section-head" style={{ padding: "0 0 6px" }}>Recent</div>
            <div className="recent">
              {recents.map((r) => (
                <div key={r} className="item" onClick={() => void open(r)}>
                  <span className="icon"><Folder size={15} /></span>
                  <span className="name">{r.split(/[\\/]/).filter(Boolean).slice(-1)[0]}<span className="muted mono" style={{ fontSize: 11, marginLeft: 8 }}>{r}</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
        <VersionLine />
      </div>
    </div>
  );
}

function VersionLine() {
  const current = useUpdater((s) => s.current);
  const phase = useUpdater((s) => s.phase);
  if (!current) return null;
  return (
    <div className="muted" style={{ fontSize: 12, display: "flex", gap: 10, justifyContent: "center" }}>
      <span>Version {current}</span>·
      <button className="link-btn" style={{ fontSize: 12 }} disabled={phase === "checking"} onClick={() => void checkForUpdate(true)}>
        {phase === "checking" ? "Checking…" : "Check for updates"}
      </button>
    </div>
  );
}
