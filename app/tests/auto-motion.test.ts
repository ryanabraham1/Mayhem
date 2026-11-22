// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { execute } from "../../scripts/mayhem.mjs";
import type { Recording } from "../src/suite/core/analysis.ts";
import { analyzeMotion, motionOfFrames, motionOfLog, type GoalSample } from "../src/suite/core/autoMotion.ts";
import { editAuto } from "../src/suite/core/autoEdit.ts";
import { plotAuto } from "../src/suite/core/autoPlot.ts";
import { diagnoseLog } from "../src/suite/core/logdiagnose.ts";
import { parseProject, type SuiteProject } from "../src/suite/core/model.ts";
import { simulate } from "../src/suite/core/runtime.ts";
import { sampleProject } from "../src/suite/core/sample.ts";

/** A fast run into a stop on a robot that brakes slowly: the P law starts braking too late. */
function overshootProject(): SuiteProject {
  const p = structuredClone(sampleProject);
  p.robot.start = { x: 2, y: 2, heading: 0 };
  p.robot.constraints.maxAcceleration = 5;
  return parseProject(JSON.stringify(editAuto(p, [{ create: { id: "dash", steps: [{ id: "near", x: 3.5, y: 2.5, heading: 0 }, { id: "far", x: 6.5, y: 2.4, heading: 0.7 }] } }]).project));
}

/** Approach to within 1 cm, swing 8 cm past, come back (a log of a stop step). */
function overshootSamples(): GoalSample[] {
  const out: GoalSample[] = [];
  for (let k = 0; k <= 60; k++) {
    const t = k * 0.02;
    const error = t < 0.6 ? 1 - t * 1.65 : t < 0.8 ? 0.01 + (t - 0.6) * 0.35 : Math.max(0.01, 0.08 - (t - 0.8) * 0.2);
    out.push({ time: 1 + t, goal: "score", error, reached: k === 60 });
  }
  return out;
}

describe("auto motion", () => {
  it("finds an overshoot that crawls back, with a braking fix", () => {
    const { steps, issues } = analyzeMotion(overshootSamples());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "overshoot", step: "score", severity: "warning" });
    expect(issues[0].amount).toBeCloseTo(0.07, 2);
    expect(issues[0].suggest?.[0].set).toBe("score.constraints.stopDeceleration");
    expect(steps[0].overshoot).toBeCloseTo(0.07, 2);
  });

  it("ignores pass-through points and clean stops", () => {
    expect(analyzeMotion(overshootSamples(), () => ({ name: "s", tolerance: 0.1, rotationTolerance: 0.05, stop: false, stopDeceleration: 0, stopLag: 0, maxAcceleration: 12, minVelocity: 0, fixedHeading: true })).issues).toEqual([]);
    const clean = Array.from({ length: 40 }, (_, k) => ({ time: k * 0.02, goal: "g", error: Math.max(0.005, 1 - k * 0.03), reached: k === 39 }));
    expect(analyzeMotion(clean).issues).toEqual([]);
  });

  it("finds a heading swing past its target", () => {
    const samples = Array.from({ length: 50 }, (_, k) => {
      const t = k * 0.02;
      const rotation = t < 0.4 ? 0.8 - t * 2 : t < 0.6 ? (t - 0.4) * 1 : Math.max(0.01, 0.2 - (t - 0.6) * 0.8);
      return { time: t, goal: "aim", error: 0.01, rotation, reached: k === 49 };
    });
    const issue = analyzeMotion(samples).issues.find((i) => i.kind === "heading-overshoot");
    expect(issue?.amount).toBeGreaterThan(8);
  });

  it("sees the robot follower overshoot (hidden by the editor preview), and stopDeceleration removes it", () => {
    const bad = overshootProject();
    const routine = bad.routines.find((r) => r.id === "dash")!;
    // The editor's path preview brakes on an ideal profile: no overshoot there.
    const editor = simulate(bad, routine, {}, { mode: "path" });
    expect(motionOfFrames(bad, routine, editor.frames).issues.filter((i) => i.kind === "overshoot")).toEqual([]);
    const run = simulate(bad, routine, {}, { mode: "path", follower: "native" });
    const { issues } = motionOfFrames(bad, routine, run.frames);
    const overshoot = issues.find((i) => i.kind === "overshoot");
    expect(overshoot?.amount).toBeGreaterThan(0.3);
    const fix = overshoot!.suggest![0];
    const fixed = parseProject(JSON.stringify(editAuto(bad, [{ set: fix.set, value: fix.value }], "dash").project));
    const again = simulate(fixed, fixed.routines.find((r) => r.id === "dash")!, {}, { mode: "path", follower: "native" });
    expect(motionOfFrames(fixed, fixed.routines.find((r) => r.id === "dash")!, again.frames).issues.filter((i) => i.kind === "overshoot")).toEqual([]);
    expect(again.frame.time).toBeLessThan(run.frame.time);
  });

  it("reads goal progress from a log and reports it in log_diagnose with a stable id", () => {
    const samples = overshootSamples();
    const recording: Recording = {
      name: "run.wpilog", duration: 3, warnings: [],
      channels: [
        { name: "Mayhem/Goals/Autonomous/id", type: "string", samples: samples.map((s) => ({ time: s.time, value: s.goal })) },
        { name: "Mayhem/Goals/Autonomous/translationError", type: "double", samples: samples.map((s) => ({ time: s.time, value: s.error })) },
        { name: "Mayhem/Goals/Autonomous/reached", type: "boolean", samples: samples.map((s) => ({ time: s.time, value: !!s.reached })) },
      ],
    };
    expect(motionOfLog(recording)[0]).toMatchObject({ runner: "Autonomous", issues: [{ kind: "overshoot", step: "score" }] });
    const finding = diagnoseLog(recording).findings.find((f) => f.kind === "auto-overshoot");
    expect(finding?.id).toBe("auto-overshoot:Autonomous/score");
    expect(finding?.next?.tool).toBe("log_table");
  });
});

describe("edit_auto ops", () => {
  const base = () => structuredClone(sampleProject);

  it("creates a chain, inserts into an exit, moves and removes", () => {
    const { project, changes } = editAuto(base(), [
      { create: { id: "r", steps: [{ id: "a", x: 2, y: 2, heading: 0 }, { id: "b", x: 4, y: 2, heading: 0 }, { id: "fire", kind: "action", action: "shooter.fire" }] } },
      { insert: { id: "m", x: 3, y: 3 }, after: "a" },
      { move: "b", y: 2.5 },
    ]);
    const r = project.routines.find((r) => r.id === "r")!;
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "m", "b", "fire", "r-done"]);
    expect(r.nodes.find((n) => n.id === "a")!.goal!.stop).toBeUndefined();
    expect(r.nodes.find((n) => n.id === "b")!.goal).toMatchObject({ stop: true, y: 2.5, translationTolerance: 0.03 });
    expect(r.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(["a>m", "b>fire", "fire>r-done", "m>b"]);
    expect(changes).toHaveLength(3);
    const removed = editAuto(project, [{ remove: "m" }], "r").project.routines.find((x) => x.id === "r")!;
    expect(removed.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(["a>b", "b>fire", "fire>r-done"]);
  });

  it("sets fields by path, deletes with null, and rejects bad edits", () => {
    const { project } = editAuto(base(), [{ set: "score.constraints.stopDeceleration", value: 6 }, { set: "routine.constraints.stopLag", value: 0.05 }]);
    const r = project.routines[0];
    expect(r.nodes.find((n) => n.id === "score")!.constraints).toEqual({ stopDeceleration: 6 });
    expect(r.constraints?.stopLag).toBe(0.05);
    expect(editAuto(project, [{ set: "score.constraints", value: null }]).project.routines[0].nodes.find((n) => n.id === "score")!.constraints).toBeUndefined();
    expect(() => editAuto(base(), [{ set: "nope.goal.x", value: 1 }])).toThrow(/does not start with a step/);
    expect(() => editAuto(base(), [{ set: "score.goal.x", value: "far" }])).toThrow(/invalid/);
    expect(() => editAuto(base(), [{ remove: "shoot" }])).not.toThrow();
  });
});

describe("plot_auto", () => {
  it("draws a PNG", () => {
    const project = overshootProject();
    const routine = project.routines.find((r) => r.id === "dash")!;
    const run = simulate(project, routine, {}, { mode: "path", follower: "native" });
    const planned = run.frames.map((f) => ({ time: f.time, x: f.pose.x, y: f.pose.y, heading: f.pose.heading, speed: Math.hypot(f.velocity.vx, f.velocity.vy), goal: f.node }));
    const issues = motionOfFrames(project, routine, run.frames).issues.map((i) => ({ ...i, source: "preview" as const }));
    const png = plotAuto({ project, routine, planned, issues, title: "Dash" }, (d) => deflateSync(d));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(1600);
    // The image data inflates to width × height RGBA rows.
    const idat = png.indexOf(0x49, 33); // "I" of IDAT
    expect(String.fromCharCode(...png.subarray(idat, idat + 4))).toBe("IDAT");
    const length = view.getUint32(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + length)).length).toBe((1600 * 4 + 1) * view.getUint32(20));
  });
});

describe("MCP tools", () => {
  const dir = mkdtemp(join(tmpdir(), "mayhem-auto-"));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  it("edit_auto saves, reports fixed problems and plots; plot_auto writes the image", async () => {
    const path = join(await dir, "robot.mayhem.json");
    await writeFile(path, JSON.stringify(overshootProject()));
    const sim = await execute("simulate_auto", { path, routine: "dash", mode: "path" });
    expect(sim.motion.issues[0]).toMatchObject({ kind: "overshoot", step: "far" });
    const fix = sim.motion.issues[0].suggest[0];
    const edited = await execute("edit_auto", { path, routine: "dash", ops: [{ set: fix.set, value: fix.value }], plot: true });
    expect(edited.effects[0]).toMatchObject({ routine: "dash", fixed: ["overshoot:far"], new: [] });
    expect(edited.revision).toBe(1);
    expect((await readFile(edited.plot.image)).subarray(1, 4).toString()).toBe("PNG");
    const dry = await execute("edit_auto", { path, routine: "dash", ops: [{ move: "far", x: 6 }], dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, revision: 1 });
    const out = join(await dir, "dash.png");
    expect(await execute("plot_auto", { path, routine: "dash", out })).toMatchObject({ image: out, routine: "dash", preview: { status: "completed" } });
  });
});
