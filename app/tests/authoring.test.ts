// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { execute } from "../../scripts/mayhem.mjs";
import {
  formatCondition,
  keyTimes,
  IMPORT_DEFAULTS,
  machineFromSpec,
  parseCondition,
  parseTransitionLine,
  specFromMachine,
  type MachineSpec,
  type Mtraj,
} from "../src/suite/core/authoring.ts";
import { canonicalJson } from "../src/suite/core/export-cpp.ts";
import { parseProject, type Condition } from "../src/suite/core/model.ts";
import { sampleProject } from "../src/suite/core/sample";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = resolve(root, "scripts/mayhem.mjs");
const directory = await mkdtemp(join(tmpdir(), "mayhem-authoring-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const types = new Map<string, "boolean" | "number" | "string">([
  ["enabled", "boolean"], ["deploy", "boolean"], ["hoodClear", "boolean"], ["stopAll", "boolean"],
  ["speed", "number"], ["mode", "string"], ["intake.requested", "boolean"],
]);
const sig = (key: string, value: boolean | number | string = true, op: "eq" | "gt" | "lt" = "eq"): Condition => ({ kind: "signal", key, op, value });

describe("readable conditions", () => {
  it("parses &&, ||, !, words, parentheses and comparisons into the condition tree", () => {
    expect(parseCondition("enabled && deploy && !hoodClear", types)).toEqual({
      kind: "all", conditions: [sig("enabled"), sig("deploy"), sig("hoodClear", false)],
    });
    expect(parseCondition("!enabled || stopAll", types)).toEqual({ kind: "any", conditions: [sig("enabled", false), sig("stopAll")] });
    expect(parseCondition("enabled and (deploy or not hoodClear)", types)).toEqual({
      kind: "all", conditions: [sig("enabled"), { kind: "any", conditions: [sig("deploy"), sig("hoodClear", false)] }],
    });
    expect(parseCondition('speed > 2.5 && mode == "hub"', types)).toEqual({ kind: "all", conditions: [sig("speed", 2.5, "gt"), sig("mode", "hub")] });
    expect(parseCondition("speed >= 2", types)).toEqual({ kind: "not", condition: sig("speed", 2, "lt") });
    expect(parseCondition("speed <= -1e-3", types)).toEqual({ kind: "not", condition: sig("speed", -0.001, "gt") });
    expect(parseCondition("mode != 'a # b'", types)).toEqual({ kind: "not", condition: sig("mode", "a # b") });
    expect(parseCondition("enabled == false", types)).toEqual(sig("enabled", false));
    expect(parseCondition("!(enabled && deploy)", types)).toEqual({ kind: "not", condition: { kind: "all", conditions: [sig("enabled"), sig("deploy")] } });
    expect(parseCondition("always", types)).toEqual({ kind: "always" });
    expect(parseCondition("stateTime > 2.5", types)).toEqual(sig("stateTime", 2.5, "gt"));
    expect(parseCondition("intake.requested", types)).toEqual(sig("intake.requested"));
  });
  it("rejects misspelled inputs, type mismatches and stray tokens with the reason", () => {
    expect(() => parseCondition("enabled && hoodClaer", types)).toThrow(/Unknown input "hoodClaer"/);
    expect(() => parseCondition("speed", types)).toThrow(/"speed" is a number; compare it/);
    expect(() => parseCondition("enabled == 1", types)).toThrow(/"enabled" is a boolean but is compared with 1/);
    expect(() => parseCondition("mode > 1", types)).toThrow(/is a string but is compared/);
    expect(() => parseCondition("enabled > true", types)).toThrow(/needs a number input/);
    expect(() => parseCondition("enabled deploy", types)).toThrow(/Unexpected "deploy"/);
    expect(() => parseCondition("(enabled", types)).toThrow(/Expected "\)"/);
    expect(() => parseCondition("enabled & deploy", types)).toThrow(/Cannot read the condition/);
  });
  it("formats conditions back to text that parses to the same tree", () => {
    const cases = [
      "enabled && deploy && !hoodClear",
      "!enabled || stopAll",
      "enabled && (deploy || !hoodClear)",
      "speed >= 2",
      'mode != "hub"',
      "!(enabled && deploy)",
      "(enabled || deploy) && speed > 1 && speed < 3",
      "always",
    ];
    for (const text of cases) {
      expect(formatCondition(parseCondition(text, types))).toBe(text);
      expect(parseCondition(formatCondition(parseCondition(text, types)), types)).toEqual(parseCondition(text, types));
    }
  });
  it("reads the transition shorthand, with names after # and '* except'", () => {
    expect(parseTransitionLine("OFF -> SHOOTING: (shootHeld || autoShooting) && !outtakeHeld  # A held / auto")).toEqual({
      from: "OFF", to: "SHOOTING", when: "(shootHeld || autoShooting) && !outtakeHeld", name: "A held / auto",
    });
    expect(parseTransitionLine('* except HOME, IDLE -> SHOOT: mode == "a#b"')).toEqual({
      from: "*", to: "SHOOT", when: 'mode == "a#b"', except: ["HOME", "IDLE"],
    });
    expect(() => parseTransitionLine("OFF SHOOTING enabled")).toThrow(/FROM -> TO: condition/);
  });
});

const shooterSpec = (): MachineSpec => ({
  id: "ShooterMode",
  name: "Shooter mode",
  initial: "OFF",
  source: "src/main/cpp/subsystems/Superstructure.cpp",
  inputChannel: "/RealOutputs/Mayhem/States/Superstructure/inputs/{key}",
  inputs: {
    operator: { shootHeld: "A held (shoot)", outtakeHeld: "Left trigger held (outtake)" },
    internal: { enabled: "Robot enabled", stopAll: { name: "Stop everything", event: true }, autoShooting: "Auto is shooting" },
    sensor: { inAllianceZone: "In alliance zone (pose)", distance: { name: "Shot distance", type: "number", unit: "m", initial: 3 } },
  },
  states: { OFF: "Off", REV: { name: "Rev", description: "Pre-spin in the alliance zone." }, SHOOTING: "Shooting" },
  transitions: [
    "* -> OFF: !enabled || stopAll  # Disabled or stop all",
    "OFF -> SHOOTING: (shootHeld || autoShooting) && !outtakeHeld && distance < 6  # A held / auto",
    "REV -> SHOOTING: (shootHeld || autoShooting) && !outtakeHeld  # A held / auto",
    { from: "SHOOTING", to: "OFF", when: "outtakeHeld || (!shootHeld && !autoShooting)", name: "A released / outtaking", description: "Inside the alliance zone it goes straight on to Rev." },
    "OFF -> REV: enabled && inAllianceZone  # In alliance zone",
    "REV -> OFF: !inAllianceZone || stateTime > 30  # Left alliance zone",
  ],
});

describe("machine specs", () => {
  it("expands a spec into a validated manifest: categories, events, channels, generated IDs, stateTime", () => {
    const m = machineFromSpec(shooterSpec());
    expect(m.states).toEqual([
      { id: "OFF", name: "Off", source: "src/main/cpp/subsystems/Superstructure.cpp" },
      { id: "REV", name: "Rev", description: "Pre-spin in the alliance zone.", source: "src/main/cpp/subsystems/Superstructure.cpp" },
      { id: "SHOOTING", name: "Shooting", source: "src/main/cpp/subsystems/Superstructure.cpp" },
    ]);
    expect(m.inputs.find((i) => i.key === "stopAll")).toEqual({
      key: "stopAll", name: "Stop everything", type: "boolean", initial: false, category: "internal", event: true,
      channel: "/RealOutputs/Mayhem/States/Superstructure/inputs/stopAll",
    });
    expect(m.inputs.find((i) => i.key === "distance")).toMatchObject({ type: "number", initial: 3, unit: "m", category: "sensor" });
    expect(m.inputs.at(-1)).toEqual({
      key: "stateTime", name: "Seconds in this state", type: "number", initial: 0, unit: "s", category: "timer",
      channel: "/RealOutputs/Mayhem/States/Superstructure/inputs/stateTime",
    });
    expect(m.transitions.map((t) => t.id)).toEqual(["any-to-OFF", "OFF-to-SHOOTING", "REV-to-SHOOTING", "SHOOTING-to-OFF", "OFF-to-REV", "REV-to-OFF"]);
    expect(m.transitions[3]).toMatchObject({ name: "A released / outtaking", description: "Inside the alliance zone it goes straight on to Rev." });
    expect(m.transitions[0].condition).toEqual({ kind: "any", conditions: [sig("enabled", false), sig("stopAll")] });
  });
  it("names the machine and transition when a spec is wrong", () => {
    const typo = shooterSpec();
    typo.transitions[2] = "REV -> SHOOTING: shootHled";
    expect(() => machineFromSpec(typo)).toThrow(/Machine ShooterMode: transition 3 \(REV -> SHOOTING\): Unknown input "shootHled"/);
    const state = shooterSpec();
    state.transitions.push("REV -> SHOTING: enabled");
    expect(() => machineFromSpec(state)).toThrow(/Machine ShooterMode: Invalid machine transition/);
    expect(() => machineFromSpec({ ...shooterSpec(), inputs: { buttons: { a: "A" } } as any })).toThrow(/unknown input category "buttons"/);
    const twice = shooterSpec();
    twice.transitions.push("OFF -> REV: inAllianceZone");
    expect(machineFromSpec(twice).transitions.at(-1)!.id).toBe("OFF-to-REV-2");
  });
  it("round-trips existing machines through specFromMachine", () => {
    const team = parseProject(readFileSync(resolve(root, "examples/suite/team3256-offseason-2026.mayhem.json"), "utf8"));
    const competition = parseProject(readFileSync(resolve(root, "examples/suite/competition.mayhem.json"), "utf8"));
    // Inputs are regrouped by category, a missing category is written as its default, and
    // conditions are normalized (not(b == true) is b == false; nested groups are flattened).
    const normal = (c: Condition): Condition => {
      if (c.kind === "not") {
        const inner = normal(c.condition);
        return inner.kind === "signal" && inner.op === "eq" && typeof inner.value === "boolean" ? { ...inner, value: !inner.value } : { kind: "not", condition: inner };
      }
      if (c.kind === "all" || c.kind === "any") {
        const parts = c.conditions.map(normal).flatMap((x) => (x.kind === c.kind ? x.conditions : [x]));
        return parts.length === 1 ? parts[0] : { kind: c.kind, conditions: parts };
      }
      return c;
    };
    const sorted = (m: any) =>
      canonicalJson({
        ...m,
        transitions: m.transitions.map((t: any) => ({ ...t, condition: normal(t.condition) })),
        inputs: m.inputs
          .map((i: any) => ({ ...i, category: i.category ?? (i.key === "stateTime" ? "timer" : "internal") }))
          .sort((a: any, b: any) => a.key.localeCompare(b.key)),
      });
    for (const m of [...(team.extensions.machines as any[]), ...(competition.extensions.machines as any[]), machineFromSpec(shooterSpec())])
      expect(sorted(machineFromSpec(specFromMachine(m)))).toBe(sorted(m));
    const spec = specFromMachine(machineFromSpec(shooterSpec()));
    expect(spec.inputChannel).toBe("/RealOutputs/Mayhem/States/Superstructure/inputs/{key}");
    expect(spec.source).toBe("src/main/cpp/subsystems/Superstructure.cpp");
    expect(spec.transitions[1]).toEqual({ from: "OFF", to: "SHOOTING", when: "(shootHeld || autoShooting) && !outtakeHeld && distance < 6", name: "A held / auto" });
  });
});

/** A small solved pass: east along y = 1, a quarter turn, then north, intake halfway. */
function syntheticPass(name: string): Mtraj {
  const samples = [];
  for (let k = 0; k <= 100; k++) {
    const t = k * 0.04;
    const [x, y, vx, vy] = t <= 2 ? [1 + t, 1, 1, 0] : [3, 1 + (t - 2), 0, 1];
    samples.push({ t, x, y, heading: t <= 2 ? 0 : Math.PI / 2, vx: vx * (t < 3.6 ? 2 : 1), vy: vy * (t < 3.6 ? 2 : 1) });
  }
  return { name, output: { samples, waypointTimes: [0, 2, 4], events: [{ name: "intake", t: 1 }, { name: "idle", t: 4 }] } };
}

describe("routes from .mtraj passes", () => {
  it("keeps the waypoints and the corners, with solved headings, speed caps and mapped events", () => {
    const pass = syntheticPass("Synthetic");
    expect(keyTimes(pass, IMPORT_DEFAULTS)).toEqual([2, 4]);
  });
  it("imports through the CLI and MCP, revision-checked, with steps after each pass", async () => {
    const project = join(directory, "robot.mayhem.json");
    await writeFile(project, JSON.stringify(sampleProject));
    await mkdir(join(directory, "solved"));
    await writeFile(join(directory, "solved/first.mtraj"), JSON.stringify(syntheticPass("First")));
    await writeFile(join(directory, "solved/second.mtraj"), JSON.stringify(syntheticPass("Second")));
    const spec = {
      events: { intake: "superstructure.intake" },
      endEvents: ["superstructure.stow"],
      options: { finalSpeed: 2.5 },
      routines: [
        {
          routine: "sweep",
          name: "Sweep",
          finish: { id: "done" },
          passes: [
            { mtraj: "solved/first.mtraj", after: [{ id: "shoot-1", kind: "custom", action: "drivetrain.alignAndShoot", timeout: 3.5, onTimeout: "succeed" }] },
            { mtraj: "solved/second.mtraj" },
          ],
        },
      ],
    };
    const dry = await execute("import_mtraj_route", { path: project, spec, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, routines: [{ routine: "sweep", steps: 6 }] });
    expect(dry.warnings).toEqual([
      'First: event "idle" at 4.00 s has no mapping in "events"; skipped.',
      'Second: event "idle" at 4.00 s has no mapping in "events"; skipped.',
    ]);
    const routine = dry.preview[0];
    expect(routine.nodes.map((n: any) => n.id)).toEqual(["sweep-pass1-p1", "sweep-pass1-p2", "shoot-1", "sweep-pass2-p1", "sweep-pass2-p2", "done"]);
    expect(routine.start).toEqual({ x: 1, y: 1, heading: 0 });
    expect(routine.nodes[0].goal).toMatchObject({ x: 3, y: 1, heading: 0, stop: false, markers: [{ kind: "event", t: 0.5, key: "superstructure.intake" }] });
    expect(routine.nodes[0].constraints).toEqual({ maxVelocity: 2, handoffRadius: 0.3 });
    expect(routine.nodes[1].goal).toMatchObject({ x: 3, y: 3, heading: 1.5708, stop: true, markers: [{ kind: "event", t: 1, key: "superstructure.stow" }] });
    expect(routine.nodes[1].constraints).toEqual({ maxVelocity: 2.5 });
    expect(routine.nodes[2]).toEqual({ id: "shoot-1", name: "drivetrain.alignAndShoot", timeout: 3.5, kind: "custom", action: "drivetrain.alignAndShoot", onTimeout: "succeed" });
    expect(routine.transitions[2]).toEqual({ id: "t2", from: "shoot-1", to: "sweep-pass2-p1", condition: { kind: "always" } });
    expect(JSON.parse(await readFile(project, "utf8")).routines.some((r: any) => r.id === "sweep")).toBe(false);  // dry run wrote nothing
    // The CLI writes with a revision bump; a stale --expect-revision is refused.
    await writeFile(join(directory, "route.json"), JSON.stringify(spec));
    const out = JSON.parse(execFileSync(process.execPath, [script, "route", "import-mtraj", project, join(directory, "route.json"), "--expect-revision", "0"], { encoding: "utf8" }));
    expect(out).toMatchObject({ revision: 1, routines: [{ routine: "sweep", steps: 6 }] });
    const saved = parseProject(await readFile(project, "utf8"));
    expect(saved.routines.find((r) => r.id === "sweep")!.nodes).toEqual(routine.nodes);
    await expect(execute("import_mtraj_route", { path: project, spec, expectedRevision: 0 })).rejects.toThrow(/Revision conflict: current revision is 1/);
    await expect(execute("import_mtraj_route", { path: project, spec: { routine: "x", passes: [{ mtraj: "solved/missing.mtraj" }] } })).rejects.toThrow(/ENOENT/);
  });
});

describe("machine apply through the CLI and MCP", () => {
  it("applies specs in place, prints a spec back, and lists the tools over MCP", async () => {
    const project = join(directory, "machines.mayhem.json");
    const team = JSON.parse(readFileSync(resolve(root, "examples/suite/team3256-offseason-2026.mayhem.json"), "utf8"));
    team.revision = 4;
    await writeFile(project, JSON.stringify(team));
    const intake = { id: "Superstructure", inputs: { operator: { go: "Go" } }, states: ["IDLE", "RUN"], transitions: ["IDLE -> RUN: go", "RUN -> IDLE: !go"] };
    const dry = await execute("apply_machine_spec", { path: project, spec: [shooterSpec(), intake], dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, revision: 4, machines: ["ShooterMode", "Superstructure"], warnings: [] });
    expect(dry.manifests[1].transitions[1].condition).toEqual(sig("go", false));
    const out = JSON.parse(execFileSync(process.execPath, [script, "machine", "apply", project, JSON.stringify({ machines: [intake, shooterSpec()] })], { encoding: "utf8" }));
    expect(out).toMatchObject({ revision: 5, machines: ["Superstructure", "ShooterMode"] });
    const saved = parseProject(await readFile(project, "utf8"));
    expect((saved.extensions.machines as any[]).map((m) => m.id)).toEqual(["Superstructure", "ShooterMode"]);  // replaced in place, appended
    const printed = JSON.parse(execFileSync(process.execPath, [script, "machine", "spec", project, "ShooterMode"], { encoding: "utf8" }));
    expect(machineFromSpec(printed)).toEqual(machineFromSpec(shooterSpec()));
    await expect(execute("apply_machine_spec", { path: project, spec: { ...intake, transitions: ["IDLE -> RUN: og"] } })).rejects.toThrow(/Unknown input "og"/);
    expect(parseProject(await readFile(project, "utf8")).revision).toBe(5);  // a failed apply writes nothing
    await expect(execute("machine_spec", { path: project, machine: "Nope" })).rejects.toThrow(/Machines: Superstructure, ShooterMode/);
    const mcp = execFileSync(process.execPath, [script, "mcp"], {
      input: [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "machine_spec", arguments: { path: project, machine: "Superstructure" } } },
      ].map((m) => JSON.stringify(m)).join("\n") + "\n",
      encoding: "utf8",
    }).trim().split("\n").map((l) => JSON.parse(l));
    const names = mcp[0].result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["apply_machine_spec", "machine_spec", "import_mtraj_route"]));
    expect(JSON.parse(mcp[1].result.content[0].text).transitions).toEqual([{ from: "IDLE", to: "RUN", when: "go" }, { from: "RUN", to: "IDLE", when: "!go" }]);
  });
});
