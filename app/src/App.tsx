import { useEffect } from "react";
import { CheckCircle2, Info, OctagonAlert, X } from "lucide-react";
import { useStore } from "./store";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Toolstrip } from "./components/Toolstrip";
import { Stage } from "./components/Stage";
import { BottomBar } from "./components/Timeline";
import { SettingsModal } from "./components/SettingsModal";
import { FolderPickerModal, Welcome } from "./components/Welcome";
import { UpdateBanner } from "./components/UpdateBanner";
import { startUpdateChecks } from "./updater";

export default function App() {
  const project = useStore((s) => s.project);
  const toasts = useStore((s) => s.toasts);

  useEffect(() => {
    useStore.getState().init();
    startUpdateChecks();
    try {
      if (localStorage.getItem("mayhem.theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo(); else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); s.redo(); return; }
      if (mod && e.key === "Enter" && s.selectedTraj) { e.preventDefault(); void s.solve(s.selectedTraj); return; }
      if (mod && e.key === ",") { e.preventDefault(); s.openSettings("robot"); return; }
      if (mod || e.altKey || !s.project || s.settings) return;
      const keys: Record<string, Parameters<typeof s.setTool>[0]> = s.view === "field"
        ? { v: "select", p: "polygon", c: "circle" }
        : { v: "select", w: "pose", t: "translation", g: "guide" };
      const t = keys[e.key.toLowerCase()];
      if (t) s.setTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {project ? (
        <div className="shell">
          <TopBar />
          <div className="body">
            <Sidebar />
            <div className="work">
              <Toolstrip />
              <Stage />
            </div>
          </div>
          <BottomBar />
        </div>
      ) : (
        <div className="shell" style={{ gridTemplateRows: "48px 1fr" }}>
          <TopBar />
          <Welcome />
        </div>
      )}
      <SettingsModal />
      <FolderPickerModal />
      <UpdateBanner />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "error" ? <OctagonAlert size={17} /> : t.kind === "success" ? <CheckCircle2 size={17} /> : <Info size={17} />}
            <div style={{ flex: 1 }}>{t.text}</div>
            <button className="link-btn" onClick={() => useStore.getState().dismissToast(t.id)}><X size={14} /></button>
          </div>
        ))}
      </div>
    </>
  );
}
