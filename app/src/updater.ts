// App self-update via tauri-plugin-updater.
//
// Releases publish a signed `latest.json` next to the installers (see .github/workflows/release.yml);
// the endpoint and public key live in src-tauri/tauri.conf.json. The app checks shortly after launch
// and every few hours, then offers the update in a banner — nothing installs until the user clicks.
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./backend";
import { flushSaves, useStore } from "./store";

export const RELEASES_URL = "https://github.com/ryanabraham1/Mayhem/releases";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "restarting" | "error";

interface UpdaterState {
  current: string | null;
  phase: UpdatePhase;
  /** Version offered by the latest release, once a check finds one. */
  version: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  /** "Later" hides the banner until the next launch; the top bar keeps a small button. */
  dismissed: boolean;
  lastChecked: number | null;
}

export const useUpdater = create<UpdaterState>(() => ({
  current: null,
  phase: "idle",
  version: null,
  downloaded: 0,
  total: null,
  error: null,
  dismissed: false,
  lastChecked: null,
}));

let pending: Update | null = null;

const busy = () => ["checking", "downloading", "restarting"].includes(useUpdater.getState().phase);

/** `manual` checks report "up to date" and errors; background checks stay quiet. */
export async function checkForUpdate(manual = false) {
  if (!isTauri() || busy()) return;
  useUpdater.setState({ phase: "checking", error: null });
  try {
    const update = await check({ timeout: 20_000 });
    if (update) {
      const previous = pending;
      pending = update;
      await previous?.close().catch(() => {});
      useUpdater.setState((s) => ({
        phase: "available",
        version: update.version,
        error: null,
        dismissed: manual ? false : s.dismissed && s.version === update.version,
        lastChecked: Date.now(),
      }));
    } else {
      useUpdater.setState({ phase: "idle", version: null, lastChecked: Date.now() });
      if (manual) useStore.getState().toast("success", `Mayhem ${useUpdater.getState().current ?? ""} is up to date`);
    }
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // A failed background check (offline at an event, GitHub hiccup) keeps offering a known update.
    useUpdater.setState({ phase: pending ? "available" : manual ? "error" : "idle", error: manual ? message : null });
    if (manual) useStore.getState().toast("error", `Could not check for updates: ${message}`);
    else console.warn("update check failed:", message);
  }
}

/** Downloads, verifies and installs the pending update, then restarts into it. */
export async function installUpdate() {
  const update = pending;
  if (!update || busy()) return;
  const app = useStore.getState();
  if (app.generatingAll || Object.values(app.solves).some((s) => s.status === "solving")) app.cancelGeneration();
  useUpdater.setState({ phase: "downloading", downloaded: 0, total: null, error: null, dismissed: false });
  try {
    await flushSaves();
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") useUpdater.setState({ total: ev.data.contentLength ?? null });
      else if (ev.event === "Progress") useUpdater.setState((s) => ({ downloaded: s.downloaded + ev.data.chunkLength }));
    });
    useUpdater.setState({ phase: "restarting" });
    await relaunch();
  } catch (e: any) {
    useUpdater.setState({ phase: "error", error: String(e?.message ?? e) });
  }
}

export function dismissUpdate() {
  useUpdater.setState({ dismissed: true });
}

export function reopenUpdate() {
  useUpdater.setState({ dismissed: false });
}

const RECHECK_MS = 6 * 60 * 60 * 1000;

export function startUpdateChecks() {
  if (!isTauri()) return;
  void getVersion().then((current) => useUpdater.setState({ current }));
  // Dev builds report the repo's version; don't nag while developing. Manual checks still work.
  if (import.meta.env.DEV) return;
  setTimeout(() => void checkForUpdate(), 4000);
  setInterval(() => void checkForUpdate(), RECHECK_MS);
}
