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
import { sampleProject } from "../src/suite/core/sample";
import { execute } from "../../scripts/mayhem.mjs";

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
    expect(report.findings).toEqual([expect.objectContaining({ level: "yellow", area: "controls" })]);
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
