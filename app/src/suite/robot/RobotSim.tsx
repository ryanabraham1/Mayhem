import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, FolderGit2, TriangleAlert } from "lucide-react";
import { buildReport, WORKTREE, type Snapshot } from "../core/review/report.ts";
import { SimProofView } from "../changes/SimProofView";
import { useSimProof } from "../changes/useSimProof";
import { desktop, invoke } from "../native";
import { chooseRepo, useRobotRepo } from "../robotRepo";
import { Button, EmptyState } from "../ui";
import "../changes/changes.css";

/**
 * The robot code on this computer run in its own simulation, with nothing to compare against:
 * every auto driven on the field, every button, the team's scenarios and their checks.
 */
export function RobotSim() {
  const [repo, setRepo] = useRobotRepo();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const sim = useSimProof(repo, WORKTREE);

  const load = useCallback(async () => {
    if (!desktop || !repo) return undefined;
    try {
      const next = await invoke<Snapshot>("review_snapshot", { repo, rev: WORKTREE });
      setSnapshot(next);
      setError(undefined);
      return next;
    } catch (e) {
      setError(String(e));
      setSnapshot(undefined);
      return undefined;
    }
  }, [repo]);
  useEffect(() => {
    void load();
  }, [load]);

  // The view's facts about the code (its autos, the field) come from the same snapshot, compared with itself.
  const report = useMemo(() => (snapshot ? buildReport(snapshot, snapshot) : undefined), [snapshot]);
  const source = {
    sim: {
      ...sim,
      // Re-read the files first: what gets built is whatever is on this computer right now.
      start: async () => {
        const latest = (await load()) ?? snapshot;
        if (latest) await sim.start(latest, { after: WORKTREE });
      },
    },
    snapshots: snapshot ? { after: snapshot } : undefined,
  };

  if (!desktop)
    return (
      <EmptyState icon={FlaskConical} title="Simulation needs the desktop app">
        The desktop app builds the robot code and runs it in its own simulation (or use <code>mayhem.mjs sim</code>).
      </EmptyState>
    );
  if (!repo)
    return (
      <EmptyState
        icon={FlaskConical}
        title="Choose the robot code folder"
        action={<Button variant="primary" icon={FolderGit2} onClick={() => void chooseRepo(setRepo)}>Choose robot code folder</Button>}
      >
        Runs every auto, every controller button and the team's scenarios in the robot's own simulation.
      </EmptyState>
    );
  if (error)
    return (
      <div className="mx-callout is-bad" role="alert">
        <TriangleAlert size={16} />
        <pre>{error}</pre>
      </div>
    );
  if (!report) return <p className="mx-help">Reading the robot code…</p>;
  return <SimProofView report={report} review={source} />;
}
