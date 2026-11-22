// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execute } from "../../scripts/mayhem.mjs";
import { editAuto } from "../src/suite/core/autoEdit.ts";
import { clearanceOf, fieldObstacles, inflate, optimizeAuto, scoreRoutine, shortestRoute } from "../src/suite/core/autoOptimize.ts";
import { parseProject, type SuiteProject } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample.ts";
import { DEFAULT_SEASON, seasonProjectField } from "../src/suite/core/seasons.ts";

/** A REBUILT robot like the examples: 0.85 m square, 3.5 m/s, 3 m/s². */
function base(): SuiteProject {
  const p = structuredClone(sampleProject);
  p.field = seasonProjectField(DEFAULT_SEASON);
  p.robot.length = 0.85;
  p.robot.width = 0.85;
  p.robot.constraints = { ...p.robot.constraints, maxVelocity: 3.5, maxAcceleration: 3, translationKp: 3.2 };
  return p;
}

/** An agent's route across the field: seven wiggling points, some against the blue hub. */
function sloppy(): SuiteProject {
  return parseProject(JSON.stringify(editAuto(base(), [{ create: { id: "sloppy", start: { x: 1.5, y: 2.0, heading: 0 }, steps: [
    { id: "w1", x: 2.2, y: 2.1, heading: 0.3 }, { id: "w2", x: 2.9, y: 2.6, heading: 0 }, { id: "w3", x: 3.4, y: 2.2, heading: 0.5 },
    { id: "w4", x: 4.0, y: 3.0, heading: 0 }, { id: "w5", x: 4.6, y: 3.6, heading: 1.0 }, { id: "w6", x: 5.6, y: 4.0, heading: 0.5 },
    { id: "w7", x: 6.6, y: 4.1, heading: 0 }, { id: "end", x: 7.6, y: 4.6, heading: 0 },
  ] } }]).project));
}

describe("auto optimizer", () => {
  it("finds the shortest way around the hub", () => {
    const obstacles = fieldObstacles(base());
    const hub = obstacles.find((o) => o.name === "Blue Hub")!;
    // Pushed out by r on every side: a 1.19 m square becomes 1.19 + 2r.
    const grown = inflate(hub.points as [number, number][], 0.5);
    expect(Math.max(...grown.map((p) => p[0])) - Math.min(...grown.map((p) => p[0]))).toBeCloseTo(1.1945 + 1, 3);
    const way = shortestRoute([1.5, 2.0], [7.6, 4.6], obstacles, 0.65, 0.1, base().field)!;
    expect(way).toHaveLength(1);
    // Below the hub (the straight line crosses it), past its lower right corner.
    expect(way[0][1]).toBeLessThan(3.4377);
    expect(way[0][0]).toBeGreaterThan(5.2229);
    // A clear line needs no points.
    expect(shortestRoute([1.5, 1.0], [3.5, 2.0], obstacles, 0.65, 0.1, base().field)).toEqual([]);
  });

  it("measures how deep the footprint goes into obstacles and walls", () => {
    const p = base();
    const at = (x: number, y: number, heading = 0) => ({ time: 0, pose: { x, y, heading } }) as never;
    expect(clearanceOf(p, [at(2, 2), at(2, 2)]).cost).toBe(0);
    // Robot center 0.3 m from the hub's left face: 0.425 + 0.05 − 0.3 inside.
    const hit = clearanceOf(p, [at(3.7284, 4), { ...at(3.7284, 4), time: 1 }]);
    expect(hit.depth).toBeCloseTo(0.175, 3);
    expect(hit.hits[0].obstacle).toBe("Blue Hub");
    expect(clearanceOf(p, [at(0.2, 2), { ...at(0.2, 2), time: 1 }]).hits[0].obstacle).toBe("Field wall");
  });

  it("makes an agent's wiggly route fast and clear of the hub, as edit_auto ops", () => {
    const p = sloppy();
    const res = optimizeAuto(p, { routine: "sloppy" });
    expect(res.before.clearance.hits[0].obstacle).toBe("Blue Hub");
    expect(res.after.status).toBe("completed");
    expect(res.after.clearance.cost).toBe(0);
    expect(res.after.passThrough).toBeLessThan(res.before.passThrough);
    expect(res.timeSaved).toBeGreaterThan(1);
    expect(res.after.warnings).toBeLessThanOrEqual(res.before.warnings);
    // The stop pose itself never moves.
    const end = res.project.routines.find((r) => r.id === "sloppy")!.nodes.find((n) => n.id === "end")!;
    expect([end.goal!.x, end.goal!.y]).toEqual([7.6, 4.6]);
    // The ops alone reproduce it.
    const replay = editAuto(p, res.ops, "sloppy").project;
    expect(scoreRoutine(replay, replay.routines.find((r) => r.id === "sloppy")!).time).toBe(res.after.time);
    // Optimizing the result again changes nothing.
    expect(optimizeAuto(res.project, { routine: "sloppy" }).ops).toEqual([]);
  });

  it("never moves locked steps, event-marker segments or stops", () => {
    const p = sloppy();
    const r = p.routines.find((r) => r.id === "sloppy")!;
    r.nodes.find((n) => n.id === "w3")!.goal!.markers = [{ kind: "event", t: 0.5, key: "intake" }];
    const res = optimizeAuto(p, { routine: "sloppy", lock: ["w6"] });
    const after = res.project.routines.find((r) => r.id === "sloppy")!;
    const pos = (id: string) => { const g = after.nodes.find((n) => n.id === id)?.goal; return g && [g.x, g.y]; };
    // w3 carries an event (its segment and the one before it stay), w2 leads into it, w6 is locked.
    expect(pos("w3")).toEqual([3.4, 2.2]);
    expect(pos("w2")).toEqual([2.9, 2.6]);
    expect(pos("w6")).toEqual([5.6, 4.0]);
    expect(res.after.events).toContain("intake");
    expect(res.fixed).toEqual(expect.arrayContaining([
      { step: "w6", why: "locked" },
      { step: "w3", why: expect.stringContaining("event marker") },
      { step: "end", why: "the robot stops here" },
    ]));
    for (const op of res.ops) {
      if ("move" in op) expect(["w2", "w3", "w6", "end"]).not.toContain(op.move);
      if ("remove" in op) expect(["w2", "w3", "w6", "end"]).not.toContain(op.remove);
    }
  });

  it("suggests driving through a stop that only leads to more driving, without doing it", () => {
    const p = parseProject(JSON.stringify(editAuto(base(), [{ create: { id: "hop", start: { x: 1.5, y: 2.4, heading: 0 }, steps: [
      { id: "a", x: 2.6, y: 2.4, heading: 0, stop: true }, { id: "b", x: 3.6, y: 2.45, heading: 0 },
    ] } }]).project));
    const res = optimizeAuto(p, { routine: "hop", phases: ["prune", "move", "handoff"] });
    expect(res.ops).toEqual([]);
    expect(res.suggestions[0].ops).toEqual([{ set: "a.goal.stop", value: null }]);
    expect(res.suggestions[0].timeChange).toBeLessThan(0);
  });

  describe("optimize_auto tool", () => {
    let dir = "";
    afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
    it("reports without writing, then applies with a revision bump", async () => {
      dir = await mkdtemp(join(tmpdir(), "mayhem-opt-"));
      const path = join(dir, "robot.mayhem.json");
      await writeFile(path, JSON.stringify(sloppy()));
      const text = await readFile(path, "utf8");
      const dry = await execute("optimize_auto", { path, routine: "sloppy" });
      expect(dry.applied).toBe(false);
      expect(dry.timeSaved).toBeGreaterThan(1);
      expect(dry.next).toMatchObject({ tool: "optimize_auto", args: { routine: "sloppy", apply: true } });
      expect(await readFile(path, "utf8")).toBe(text);
      const done = await execute("optimize_auto", { path, routine: "sloppy", apply: true });
      expect(done.applied).toBe(true);
      const saved = parseProject(await readFile(path, "utf8"));
      expect(saved.revision).toBe(sloppy().revision + 1);
      expect(scoreRoutine(saved, saved.routines.find((r) => r.id === "sloppy")!).time).toBe(dry.after.time);
    });
  });
});
