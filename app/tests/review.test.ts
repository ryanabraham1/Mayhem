// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCpp } from "../src/suite/core/review/cpp";
import { applyEdit, editInfo } from "../src/suite/core/review/edit";
import { duplicateIds, readDevices } from "../src/suite/core/review/hardware";
import { buildReport, settingsOf, type Snapshot } from "../src/suite/core/review/report";
import { readSettings } from "../src/suite/core/review/settings";
import { parseExplainer, robotParts } from "../src/suite/core/review/explainer";
import { sampleProject } from "../src/suite/core/sample";
import { machineFromSpec } from "../src/suite/core/authoring";
import { checkExpectations, compareOutcomes, compileSteps, parseExpectation, scenarioSet, type Outcome } from "../src/suite/core/review/scenarios";
import { execute } from "../../scripts/mayhem.mjs";
import { readItem, saveItem } from "../../scripts/review-tasks.mjs";
import { createItem, move, parseItem, serializeItem, tasksInMessage } from "../src/suite/core/review/tasks";

const SHOOTER = `// Copyright header that is not a doc comment.
#pragma once
#include <units/current.h>
namespace shooter {
/** CAN IDs; shooters[0] is the leader, the rest follow it. */
inline constexpr std::array<int, 2> kMotorIds = {
    44,  // left
    45,  // right
};
inline constexpr std::array<bool, 2> kMotorOpposed = {false, true};
inline constexpr double kIdleSpeed = 10;  // rot/s
inline constexpr double kShootSpeed = kIdleSpeed * 6;
/** Flywheel speed [rot/s] by distance to the hub [m]. */
inline constexpr util::InterpolatingMap<2> kHubLUT{{{
    {1.5, 60.0},
    {4.0, 90.0},
}}};
inline ctre::phoenix6::configs::TalonFXConfiguration MotorConfigs() {
  using namespace ctre::phoenix6;
  return configs::TalonFXConfiguration{}
      .WithSlot0(configs::Slot0Configs{}.WithKP(.1).WithKV(.12))
      .WithMotorOutput(configs::MotorOutputConfigs{}
                           .WithNeutralMode(signals::NeutralModeValue::Coast)
                           .WithInverted(signals::InvertedValue::Clockwise_Positive))
      .WithCurrentLimits(configs::CurrentLimitsConfigs{}
                             .WithStatorCurrentLimitEnable(true)
                             .WithStatorCurrentLimit(80_A)
                             .WithSupplyCurrentLimit(50_A));
}
namespace sim {
inline constexpr double kGearing = 1.5;
}  // namespace sim
}  // namespace shooter
`;
const SLIDE = `#pragma once
namespace linear_slide {
inline constexpr int kRightMotorID = 39;
inline constexpr int kLeftMotorID = 40;
inline ctre::phoenix6::configs::TalonFXConfiguration RightMotorConfigs() {
  return configs::TalonFXConfiguration{}
      .WithMotorOutput(configs::MotorOutputConfigs{}.WithNeutralMode(signals::NeutralModeValue::Brake))
      .WithCurrentLimits(configs::CurrentLimitsConfigs{}.WithStatorCurrentLimit(15_A))
      .WithFeedback(configs::FeedbackConfigs{}.WithSensorToMechanismRatio(30));
}
/** The left motor is mounted opposite the right one. */
inline ctre::phoenix6::configs::TalonFXConfiguration LeftMotorConfigs() {
  auto c = RightMotorConfigs();
  c.WithMotorOutput(configs::MotorOutputConfigs{}.WithInverted(signals::InvertedValue::CounterClockwise_Positive));
  return c;
}
}  // namespace linear_slide
`;
const MACHINES = (shootWhen: string) =>
  JSON.stringify({
    machines: [
      {
        id: "Shooter",
        inputs: { operator: { shootHeld: "A held (shoot)" }, internal: { enabled: "Robot enabled" } },
        states: { OFF: "Off", SHOOTING: "Shooting" },
        transitions: ["* -> OFF: !enabled", `OFF -> SHOOTING: ${shootWhen}`, "SHOOTING -> OFF: !shootHeld"],
      },
    ],
  });
const files = (shooter = SHOOTER, slide = SLIDE, machines = MACHINES("shootHeld && enabled")) => ({
  "src/main/include/subsystems/shooter/ShooterConstants.h": shooter,
  "src/main/include/subsystems/linearslide/LinearSlideConstants.h": slide,
  "tools/mayhem/machines.json": machines,
  "robot.mayhem.json": JSON.stringify(sampleProject),
});
const snap = (f: Record<string, string>, rev = "x"): Snapshot => ({ rev, label: rev, files: f });

describe("robot code reading", () => {
  it("reads constants with scopes, docs, list notes and configuration chains", () => {
    const { constants, configs } = readCpp("a.h", SHOOTER);
    const ids = constants.find((c) => c.short === "kMotorIds")!;
    expect(ids.name).toBe("shooter::kMotorIds");
    expect(ids.elementNotes).toEqual(["left", "right"]);
    expect(ids.doc).toMatch(/leader/);
    expect(constants.find((c) => c.short === "kGearing")!.scope).toEqual(["shooter", "sim"]);
    expect(configs[0].settings).toMatchObject({ "Slot0.KP": ".1", "CurrentLimits.StatorCurrentLimit": "80_A", "MotorOutput.NeutralMode": "signals::NeutralModeValue::Coast" });
  });

  it("evaluates derived values, units and categories, and keeps simulation values apart", () => {
    const settings = readSettings(Object.entries(files()).map(([path, text]) => ({ path, text })));
    const get = (key: string) => settings.find((s) => s.key === key)!;
    expect(get("shooter::kShootSpeed")).toMatchObject({ display: "60", refs: ["shooter::kIdleSpeed"] });
    expect(get("shooter::MotorConfigs.CurrentLimits.StatorCurrentLimit")).toMatchObject({ display: "80 A", category: "current-limit", subsystem: "Shooter" });
    expect(get("shooter::kHubLUT")).toMatchObject({ category: "lookup-table", table: [[1.5, 60], [4, 90]], tableUnits: ["m", "rot/s"] });
    expect(get("shooter::sim::kGearing").category).toBe("simulation");
    expect(get("linear_slide::kRightMotorID").category).toBe("can-id");
    // The left motor inherits the right motor's limit; editing it edits the right motor's configuration.
    expect(get("linear_slide::LeftMotorConfigs.CurrentLimits.StatorCurrentLimit").origin).toMatchObject({ name: "RightMotorConfigs", inheritedFrom: "linear_slide::RightMotorConfigs" });
  });

  it("assembles devices with their settings and finds shared CAN IDs", () => {
    const devices = readDevices(readSettings(Object.entries(files()).map(([path, text]) => ({ path, text }))));
    const left = devices.find((d) => d.key === "Linear slide / Left motor")!;
    expect(left.fields).toMatchObject({ "CAN ID": "40", "Brake / coast when idle": "Brake", "Positive direction": "Counter-clockwise", "Stator current limit": "15 A", "Gear ratio": "30" });
    const shooter2 = devices.find((d) => d.key === "Shooter / Motor 2")!;
    expect(shooter2).toMatchObject({ name: "Motor 2 (right)", canId: 45, fields: { "Opposes leader": "Yes" } });
    expect(duplicateIds(devices)).toEqual([]);
    const clash = readDevices(readSettings(Object.entries(files(SHOOTER.replace("45,", "39,"))).map(([path, text]) => ({ path, text }))));
    expect(duplicateIds(clash)).toEqual([{ kind: "Talon FX", canId: 39, devices: ["Shooter / Motor 2", "Linear slide / Right motor"] }]);
  });
});

describe("editing one value", () => {
  const settings = readSettings(Object.entries(files()).map(([path, text]) => ({ path, text })));
  const get = (key: string) => settings.find((s) => s.key === key)!;
  it("changes only the literal, keeping units, comments and formatting", () => {
    const limit = get("shooter::MotorConfigs.CurrentLimits.StatorCurrentLimit");
    const edited = applyEdit(SHOOTER, limit, "60");
    expect(edited).toBe(SHOOTER.replace("WithStatorCurrentLimit(80_A)", "WithStatorCurrentLimit(60_A)"));
    expect(applyEdit(SHOOTER, get("shooter::kMotorIds"), "46", 1)).toBe(SHOOTER.replace("45,  // right", "46,  // right"));
    expect(applyEdit(SHOOTER, get("shooter::MotorConfigs.MotorOutput.NeutralMode"), "Brake")).toContain("NeutralModeValue::Brake");
    expect(applyEdit(SHOOTER, get("shooter::kMotorOpposed"), "false", 1)).toContain("{false, false}");
  });
  it("edits an inherited value where it is written", () => {
    const left = get("linear_slide::LeftMotorConfigs.CurrentLimits.StatorCurrentLimit");
    expect(applyEdit(SLIDE, left, "20")).toBe(SLIDE.replace("WithStatorCurrentLimit(15_A)", "WithStatorCurrentLimit(20_A)"));
  });
  it("refuses computed values, bad numbers, out-of-range CAN IDs and stale source", () => {
    expect(editInfo(get("shooter::kShootSpeed"))).toEqual({ reason: "Computed from kIdleSpeed. Edit that instead." });
    expect(editInfo(get("shooter::sim::kGearing"))).toMatchObject({ reason: expect.stringMatching(/Simulation/) });
    expect(() => applyEdit(SHOOTER, get("shooter::kMotorIds"), "70", 0)).toThrow(/at most 62/);
    expect(() => applyEdit(SHOOTER, get("shooter::kMotorIds"), "4.5", 0)).toThrow(/whole number/);
    expect(() => applyEdit(SHOOTER.replace("80_A", "75_A"), get("shooter::MotorConfigs.CurrentLimits.StatorCurrentLimit"), "60")).toThrow(/changed since/);
  });
});

describe("behavior review", () => {
  it("finds nothing when nothing changed", () => {
    const report = buildReport(snap(files()), snap(files()));
    expect(report.level).toBe("none");
    expect(report.findings).toEqual([]);
  });
  it("marks hardware and safety changes red and names the device", () => {
    const report = buildReport(snap(files()), snap(files(SHOOTER.replace("80_A", "60_A").replace("NeutralModeValue::Coast", "NeutralModeValue::Brake"))));
    expect(report.level).toBe("red");
    expect(report.devices.find((d) => d.key === "Shooter / Motor 1")!.fields).toEqual([
      { field: "Brake / coast when idle", before: "Coast", after: "Brake" },
      { field: "Stator current limit", before: "80 A", after: "60 A" },
    ]);
    expect(report.findings[0]).toMatchObject({ level: "red", area: "hardware" });
  });
  it("reports derived values with the input that changed them, and lookup table rows", () => {
    const report = buildReport(snap(files()), snap(files(SHOOTER.replace("kIdleSpeed = 10", "kIdleSpeed = 12").replace("{4.0, 90.0}", "{4.0, 95.0}"))));
    expect(report.level).toBe("yellow");
    expect(report.settings.find((c) => c.key === "shooter::kShootSpeed")).toMatchObject({ because: ["shooter::kIdleSpeed"] });
    expect(report.settings.find((c) => c.key === "shooter::kHubLUT")!.rows).toEqual([{ input: 4, before: 90, after: 95 }]);
  });
  it("flags driver-control changes in the state machines", () => {
    const report = buildReport(snap(files()), snap(files(SHOOTER, SLIDE, MACHINES("shootHeld"))));
    const machine = report.machines[0];
    expect(machine.transitions).toEqual([
      expect.objectContaining({ key: "OFF -> SHOOTING", kind: "changed", before: "shootHeld && enabled", after: "shootHeld", driver: true }),
    ]);
    expect(machine.marks.edges["OFF-to-SHOOTING"]).toBe("changed");
    expect(report.findings.filter((f) => f.area === "controls")).toEqual([expect.objectContaining({ level: "yellow" })]);
    // The project file wasn't updated, so the robot still runs the old machine.
    expect(report.findings.filter((f) => f.area === "generated")).toHaveLength(1);
  });
  it("labels path-only changes that still finish green", () => {
    const project = structuredClone(sampleProject);
    const pose = project.routines[0].nodes.find((n) => n.kind === "pose")!;
    pose.goal!.x += 0.3;
    const after = { ...files(), "robot.mayhem.json": JSON.stringify(project) };
    const report = buildReport(snap(files()), snap(after));
    const routine = report.routines.find((r) => r.id === project.routines[0].id)!;
    expect(routine.kind).toBe("changed");
    expect(routine.steps[0].details).toContain("target moved 0.30 m");
    expect(routine.before!.poses.length).toBeGreaterThan(2);
    expect(report.level).toBe(routine.after!.status === "completed" ? "green" : "yellow");
  });
  it("reads every settings source in a snapshot", () => {
    expect(settingsOf(snap(files())).length).toBeGreaterThan(10);
  });
});

describe("behavior_diff agent tool", () => {
  const directory = mkdtemp(join(tmpdir(), "mayhem-review-"));
  afterAll(async () => rm(await directory, { recursive: true, force: true }));
  it("compares git revisions and the working tree", async () => {
    const repo = await directory;
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    for (const [path, text] of Object.entries(files())) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    git("add", ".");
    git("commit", "-qm", "first");
    expect(await execute("behavior_diff", { repo })).toMatchObject({ level: "none", findings: [] });
    await writeFile(join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h"), SHOOTER.replace("44,", "41,"));
    const working = await execute("behavior_diff", { repo });
    expect(working.level).toBe("red");
    expect(working.findings[0].text).toMatch(/Motor 1.*CAN ID 44 → 41/);
    git("commit", "-qam", "renumber");
    expect((await execute("behavior_diff", { repo, before: "HEAD~1", after: "HEAD" })).level).toBe("red");
  });
});

describe("sim proof scenarios", () => {
  it("reads plain step lines and expectations", () => {
    expect(compileSteps(["teleop", "hold A 2", "press rt", "stick left 0 1", "select auto Depot Sweep"])).toEqual([
      { kind: "mode", mode: "teleop" },
      { kind: "button", button: "A", down: true },
      { kind: "wait", seconds: 2 },
      { kind: "button", button: "A", down: false },
      { kind: "button", button: "RT", down: true },
      { kind: "wait", seconds: 0.06 },
      { kind: "button", button: "RT", down: false },
      { kind: "axis", axis: "leftX", value: 0 },
      { kind: "axis", axis: "leftY", value: -1 },
      { kind: "auto", name: "Depot Sweep" },
    ]);
    expect(() => compileSteps(["hold Z 1"])).toThrow(/Unknown button/);
    expect(parseExpectation("Shooter mode is SHOOTING by 1.5 s")).toEqual({ kind: "state", machine: "Shooter mode", state: "SHOOTING", by: 1.5 });
    expect(parseExpectation("Intake mode never OUTTAKING")).toMatchObject({ never: true });
    expect(parseExpectation("battery stays above 9 V")).toEqual({ kind: "battery", volts: 9 });
  });
  it("builds every button, every auto and the team's scenarios, reporting bad ones", () => {
    const { scenarios, errors } = scenarioSet(sampleProject, JSON.stringify({ scenarios: [{ name: "Hold A", steps: ["teleop", "hold A 1"], expect: ["Shooter is ON by 1 s"] }, { name: "Bad", steps: ["fly"] }] }));
    expect(scenarios.filter((s) => s.group === "button")).toHaveLength(32);
    expect(scenarios.filter((s) => s.group === "auto")).toHaveLength(sampleProject.routines.length);
    expect(scenarios.find((s) => s.group === "custom")).toMatchObject({ id: "custom-hold-a", expect: ["Shooter is ON by 1 s"] });
    expect(errors).toEqual(['scenarios.json #2: Unknown step "fly".']);
  });
  const machine = machineFromSpec(JSON.parse(MACHINES("shootHeld")).machines[0]);
  const outcome = (changes: [number, string][], extra: Partial<Outcome> = {}): Outcome => ({
    tracks: [{ name: "Shooter", channel: "Mayhem/States/Shooter/state", changes: changes.map(([time, value]) => ({ time, value })) }],
    poses: [],
    offset: 0,
    duration: 4,
    ...extra,
  });
  it("judges expectations and flags flickering states", () => {
    const s = { id: "x", name: "x", group: "custom" as const, alliance: "blue" as const, field: false, steps: [], expect: ["Shooter is SHOOTING by 1.5 s", "Shooter is OFF at 3 s", "Shooter never Off"] };
    expect(checkExpectations(s, outcome([[0, "OFF"], [1.2, "SHOOTING"], [2.8, "OFF"]]), [machine]).map((c) => c.pass)).toEqual([true, true, false]);
    const flicker = Array.from({ length: 20 }, (_, i) => [2 + i * 0.02, i % 2 ? "OFF" : "SHOOTING"] as [number, string]);
    const checks = checkExpectations({ ...s, expect: [] }, outcome([[0, "OFF"], ...flicker]), [machine]);
    expect(checks).toEqual([expect.objectContaining({ pass: false, detail: "Flips between SHOOTING and OFF 20 times (2.0–2.4 s)" })]);
  });
  it("compares before and after runs: states, timing, auto result and path", () => {
    const path = (dy: number) => ({ poses: [0, 1, 2].map((t) => ({ time: t, x: t, y: t === 2 ? dy : 0, heading: 0 })) });
    expect(compareOutcomes(outcome([[0, "OFF"], [1, "SHOOTING"]], path(0)), outcome([[0, "OFF"], [1.05, "SHOOTING"]], path(0.1))).same).toBe(true);
    const diff = compareOutcomes(outcome([[0, "OFF"], [1, "SHOOTING"]], { ...path(0), autoStatus: "Completed" }), outcome([[0, "OFF"], [2, "SHOOTING"]], { ...path(0.6), autoStatus: "Failed" }));
    expect(diff.differences).toEqual([
      "Shooter: OFF (0.0 s) → SHOOTING (1.0 s) ⇒ OFF (0.0 s) → SHOOTING (2.0 s)",
      "Auto result: Completed ⇒ Failed",
      "Path: up to 0.60 m from the old path (at 2.0 s)",
    ]);
  });
});

describe("generated robot code", () => {
  it("flags machine and auto changes the generated code doesn't carry", () => {
    const project = structuredClone(sampleProject);
    project.routines[0].nodes.find((n) => n.kind === "pose")!.goal!.x += 0.3;
    const header = { "src/main/include/commands/MayhemProject.h": "// generated" };
    const report = buildReport(snap({ ...files(), ...header }), snap({ ...files(SHOOTER, SLIDE, MACHINES("shootHeld")), ...header, "robot.mayhem.json": JSON.stringify(project) }));
    expect(report.findings.filter((f) => f.area === "generated").map((f) => f.text)).toEqual([
      expect.stringMatching(/machines.json changed but the project file's machines did not/),
      expect.stringMatching(/autos changed in robot.mayhem.json but MayhemProject.h did not/),
    ]);
    expect(report.level).toBe("red");
  });
});

describe("feedback and tasks", () => {
  it("turns feedback into tasks with context, and only allows sensible moves", () => {
    const now = new Date("2026-11-13T18:00:00Z");
    const item = createItem({ author: "Maya", kind: "thumbs-down", text: "Shooter keeps spinning after I let go of A. Happened twice.", anchor: { log: "Q14.wpilog", time: 42.5 } }, now);
    expect(item).toMatchObject({ status: "open", title: "Shooter keeps spinning after I let go of A", anchor: { log: "Q14.wpilog", time: 42.5 } });
    expect(createItem({ author: "Maya", kind: "thumbs-up", text: "" }, now).status).toBe("noted");
    expect(() => move(item, "approve", "Maya")).toThrow(/Can't approve/);
    const claimed = move(item, "claim", "claude-1", {}, now);
    expect(() => move(claimed, "plan", "claude-1", { plan: " " })).toThrow(/plan needs text/);
    expect(() => move(claimed, "plan", "codex-2", { plan: "x" })).toThrow(/belongs to claude-1/);
    const planned = move(claimed, "plan", "claude-1", { plan: "Stop the flywheel when A is released, even in the alliance zone." }, now);
    const sentBack = move(planned, "reject", "Coach Lee", { note: "Keep it revving in the zone" }, now);
    expect(sentBack).toMatchObject({ status: "claimed", planDecision: { approved: false, by: "Coach Lee", note: "Keep it revving in the zone" } });
    const approved = move(move(sentBack, "plan", "claude-1", { plan: "Lower the idle speed in the zone." }), "approve", "Coach Lee");
    expect(approved.status).toBe("approved");
    expect(parseItem(serializeItem(approved))).toEqual(approved);
    expect(tasksInMessage("Lower idle\n\nMayhem-Task: 20261113180000-ab12\nCo-Authored-By: x")).toEqual(["20261113180000-ab12"]);
  });

  it("runs the agent loop through the MCP tools, labels risk and auto-accepts path-only changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mayhem-tasks-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      for (const [path, text] of Object.entries(files())) {
        await mkdir(join(repo, path, ".."), { recursive: true });
        await writeFile(join(repo, path), text);
      }
      git("add", ".");
      git("commit", "-qm", "robot");
      const added = await execute("add_feedback", { repo, author: "Maya", kind: "thumbs-down", text: "Auto misses the first piece" });
      expect((await execute("list_tasks", { repo })).tasks.map((t: { id: string }) => t.id)).toEqual([added.id]);
      await execute("claim_task", { repo, id: added.id, agent: "claude-1" });
      await execute("propose_plan", { repo, id: added.id, agent: "claude-1", plan: "Move the first pickup 30 cm left." });
      await expect(execute("report_progress", { repo, id: added.id, agent: "claude-1", revision: "HEAD" })).rejects.toThrow(/Can't progress/);
      // A person approves in the app (same file rules).
      const { item, text } = await readItem(repo, added.id);
      await saveItem(repo, move(item, "approve", "Coach Lee"), text);
      const project = structuredClone(sampleProject);
      project.routines[0].nodes.find((n) => n.kind === "pose")!.goal!.x += 0.3;
      await writeFile(join(repo, "robot.mayhem.json"), JSON.stringify(project));
      git("commit", "-qam", `Move pickup\n\nMayhem-Task: ${added.id}`);
      const progressed = await execute("report_progress", { repo, id: added.id, agent: "claude-1", revision: "HEAD", summary: "moved pickup" });
      expect(progressed.changes[0]).toMatchObject({ summary: "moved pickup", level: expect.stringMatching(/green|yellow/) });
      const finished = await execute("finish_task", { repo, id: added.id, agent: "claude-1" });
      expect(finished.status).toBe(progressed.changes[0].level === "green" ? "done" : "review");
      // A safety change always waits for a person.
      const second = await execute("add_feedback", { repo, author: "Maya", text: "Shooter browns out" });
      await execute("claim_task", { repo, id: second.id, agent: "claude-1" });
      await execute("propose_plan", { repo, id: second.id, agent: "claude-1", plan: "Lower the shooter current limit to 60 A." });
      const r2 = await readItem(repo, second.id);
      await saveItem(repo, move(r2.item, "approve", "Coach Lee"), r2.text);
      await writeFile(join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h"), SHOOTER.replace("80_A", "60_A"));
      git("commit", "-qam", "Lower limit");
      expect((await execute("report_progress", { repo, id: second.id, agent: "claude-1", revision: "HEAD" })).changes[0].level).toBe("red");
      expect((await execute("finish_task", { repo, id: second.id, agent: "claude-1" })).status).toBe("review");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("robot explainer", () => {
  it("builds parts from devices, machines and the team's words", () => {
    const settings = readSettings(Object.entries(files()).map(([path, text]) => ({ path, text })));
    const machines = [machineFromSpec(JSON.parse(MACHINES("shootHeld")).machines[0])];
    const explainer = parseExplainer(JSON.stringify({ parts: { Shooter: "Launches pieces." } }));
    const parts = robotParts(readDevices(settings), settings, machines, explainer);
    expect(parts.map((p) => p.name)).toEqual(["Shooter", "Linear slide"]);
    expect(parts[0]).toMatchObject({ about: "Launches pieces.", controls: [{ input: "A held (shoot)", machine: "Shooter" }], paths: ["src/main/include/subsystems/shooter", "src/main/cpp/subsystems/shooter"] });
    expect(parseExplainer("not json")).toEqual({ parts: {} });
  });
});
