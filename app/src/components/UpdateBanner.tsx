import { ArrowUpCircle, Loader2, X } from "lucide-react";
import { useStore } from "../store";
import { checkForUpdate, dismissUpdate, installUpdate, RELEASES_URL, reopenUpdate, useUpdater } from "../updater";

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
const openUrl = (url: string) => void import("@tauri-apps/plugin-shell").then((m) => m.open(url));

export function UpdateBanner() {
  const u = useUpdater();
  const solving = useStore((s) => s.generatingAll || Object.values(s.solves).some((x) => x.status === "solving"));
  if (!u.version || u.dismissed || u.phase === "idle") return null;
  const working = u.phase === "downloading" || u.phase === "restarting";
  const pct = u.total ? Math.min(100, (u.downloaded / u.total) * 100) : null;

  return (
    <div className="update-banner" role="status">
      <div className="update-head">
        <span className="update-icon"><ArrowUpCircle size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="update-title">Mayhem {u.version} is available</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {u.phase === "downloading" ? (u.total ? `Downloading ${mb(u.downloaded)} of ${mb(u.total)} MB` : "Downloading…")
              : u.phase === "restarting" ? "Installed. Restarting…"
              : `You have ${u.current ?? "an older version"}.`}
          </div>
        </div>
        {!working && <button className="btn ghost icon sm" title="Remind me next launch" onClick={dismissUpdate}><X size={14} /></button>}
      </div>
      {working && (
        <div className="update-bar">
          <div style={pct === null ? undefined : { width: `${pct}%`, animation: "none" }} />
        </div>
      )}
      {u.phase === "error" && <div className="update-note error">Update failed: {u.error}</div>}
      {!working && solving && <div className="update-note">Installing stops the path that is generating. Your project is saved first.</div>}
      {!working && (
        <div className="update-actions">
          <button className="link-btn" onClick={() => openUrl(`${RELEASES_URL}/tag/v${u.version}`)}>What's new</button>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={dismissUpdate}>Later</button>
          <button className="btn sm primary" onClick={() => void installUpdate()}>
            {u.phase === "error" ? "Try again" : "Install & restart"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Small top-bar button that brings back a dismissed update banner. */
export function UpdateButton() {
  const u = useUpdater();
  if (!u.version || !u.dismissed || u.phase === "idle") return null;
  return (
    <button className="chip accent update-chip" onClick={reopenUpdate} title={`Mayhem ${u.version} is ready to install`}>
      <ArrowUpCircle size={13} /> Update
    </button>
  );
}

export function UpdateSettings() {
  const u = useUpdater();
  return (
    <>
      <h3>Version</h3>
      <div className="kv"><span>Installed</span><b>{u.current ?? "—"}</b></div>
      <div className="kv"><span>Latest</span><b>{u.version ?? (u.lastChecked ? u.current ?? "—" : "not checked yet")}</b></div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        {u.version && u.phase !== "checking" ? (
          <button className="btn primary" disabled={u.phase === "downloading" || u.phase === "restarting"} onClick={() => void installUpdate()}>
            {u.phase === "downloading" || u.phase === "restarting" ? <Loader2 size={15} className="spin" /> : <ArrowUpCircle size={15} />}
            Install {u.version} & restart
          </button>
        ) : null}
        <button className="btn" disabled={u.phase !== "idle" && u.phase !== "available" && u.phase !== "error"}
          onClick={() => void checkForUpdate(true)}>
          {u.phase === "checking" && <Loader2 size={15} className="spin" />} Check for updates
        </button>
        <button className="link-btn" onClick={() => openUrl(RELEASES_URL)}>All releases</button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
        Mayhem checks for updates when it starts and every few hours while open. Updates are downloaded from
        GitHub, verified against Mayhem's signing key, and only installed when you choose to.
        {u.lastChecked && <> Last checked {new Date(u.lastChecked).toLocaleTimeString()}.</>}
      </p>
    </>
  );
}
