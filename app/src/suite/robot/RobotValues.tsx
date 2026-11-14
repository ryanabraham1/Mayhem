import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderGit2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { applyEdit } from "../core/review/edit.ts";
import { settingsOf, WORKTREE, type Snapshot } from "../core/review/report.ts";
import type { Setting } from "../core/review/settings.ts";
import { EditSetting, type EditTarget, type ValueEditor } from "../changes/EditSetting";
import { ValuesBrowser } from "../changes/ValuesBrowser";
import { desktop, invoke } from "../native";
import { chooseRepo, useRobotRepo } from "../robotRepo";
import { Button, EmptyState } from "../ui";
import "../changes/changes.css";

/** Every value in the robot code on this computer, by kind and part, editable in place. */
export function RobotValues() {
  const [repo, setRepo] = useRobotRepo();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<EditTarget>();

  const load = useCallback(async () => {
    if (!desktop || !repo) return;
    try {
      setSnapshot(await invoke<Snapshot>("review_snapshot", { repo, rev: WORKTREE }));
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  }, [repo]);
  useEffect(() => {
    void load();
  }, [load]);

  const settings = useMemo<Setting[]>(() => (snapshot ? settingsOf(snapshot) : []), [snapshot]);
  const editor: ValueEditor = {
    settingsAfter: settings,
    preview: (setting, value, index) => {
      if (!snapshot) return { error: "Nothing loaded." };
      const file = setting.origin.file;
      try {
        return { files: { ...snapshot.files, [file]: applyEdit(snapshot.files[file], setting, value, index) } };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    edit: async (setting, value, index) => {
      if (!snapshot) throw new Error("Nothing loaded.");
      const file = setting.origin.file;
      const expected = snapshot.files[file];
      await invoke("review_write_file", { repo, path: file, expected, text: applyEdit(expected, setting, value, index) });
      await load();
    },
  };

  if (!desktop)
    return (
      <EmptyState icon={SlidersHorizontal} title="Values need the desktop app">
        The desktop app reads constants and motor settings straight from the robot code.
      </EmptyState>
    );
  if (!repo)
    return (
      <EmptyState
        icon={SlidersHorizontal}
        title="Choose the robot code folder"
        action={<Button variant="primary" icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>Choose robot code folder</Button>}
      >
        Every CAN ID, current limit, ratio and gain in the robot code, grouped by kind and part.
      </EmptyState>
    );
  return (
    <div className="mx-robot-values">
      <div className="mx-toolbar">
        <span className="mx-help">
          {snapshot ? `The robot code in ${repo.split("/").pop()} on this computer. Edits change the code here; review them on Changes.` : error ? "" : "Reading the robot code…"}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void load()}>
          Reload
        </Button>
      </div>
      {error && <p className="mx-help is-bad">{error}</p>}
      {snapshot && <ValuesBrowser settings={settings} editable editSetting={setEditing} />}
      {editing && <EditSetting review={editor} target={editing} close={() => setEditing(undefined)} />}
    </div>
  );
}
