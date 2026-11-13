// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  autonomousManifest,
  canonicalJson,
  cppIdentifiers,
  exportCpp,
  previewPath,
  qualifiedTransitionId,
} from "../src/suite/core/export-cpp.ts";
import { exampleMachine, parseMachineManifest, settleMachine, type MachineManifest } from "../src/suite/core/machines.ts";
import { parseProject, type SuiteProject } from "../src/suite/core/model.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = resolve(root, "scripts/mayhem.mjs");
const example = resolve(root, "examples/suite/competition.mayhem.json");
const load = (): SuiteProject => parseProject(readFileSync(example, "utf8"));
const dir = mkdtempSync(resolve(tmpdir(), "mayhem-export-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Decode the C++ string literals of one `manifestParts` array back into text. */
function manifestText(cpp: string, namespace: string): string {
  const block = cpp.split(`namespace ${namespace} {`)[1].split("manifestParts = {{")[1].split("}};")[0];
  const bytes: number[] = [];
  for (const [, body] of block.matchAll(/"((?:[^"\\]|\\.)*)"/g))
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== "\\") bytes.push(body.charCodeAt(i));
      else if (/[0-7]/.test(body[i + 1])) bytes.push(parseInt(body.slice(i + 1, i + 4), 8)), (i += 3);
      else bytes.push(body.charCodeAt(++i));
    }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
/** Same data with every object's keys in reverse order. */
const reverseKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reverseKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as any)[k])]))
      : v;
const twoRoutines = () => {
  const p = load();
  const second = structuredClone(p.routines[0]);
  second.id = "second";
  second.name = "Second auto";
  p.routines.push(second);
  return p;
};

describe("C++ export for robot projects", () => {
  it("exports machines with their manifests, names, and a routines array", () => {
    const cpp = exportCpp(load());
    expect(cpp).toContain("namespace machine_0 {");
    expect(cpp).toContain("namespace Intake = machine_0;");
    expect(cpp).toContain('inline bool guard_0([[maybe_unused]] const mayhem::SignalSource& h)');
    expect(cpp).toContain('{"acquire","Idle","Acquiring",guard_0}');
    expect(cpp).toContain("inline constexpr mayhem::MachineView machine{id,\"Idle\",states.data(),states.size(),transitions.data(),transitions.size(),manifest,false,inputs.data(),inputs.size()};");
    expect(cpp).toContain('inline constexpr std::string_view name = "Collect & score";');
    expect(cpp).toContain("inline constexpr std::array<mayhem::RoutineInfo,1> routines = {{\n  routine_0::info,\n}};");
    expect(cpp).toContain("inline constexpr double fieldLength = 16.541;");
    const embedded = JSON.parse(manifestText(cpp, "machine_0"));
    expect(embedded).toEqual(parseMachineManifest(exampleMachine));
    expect(manifestText(cpp, "machine_0")).toBe(canonicalJson(exampleMachine));
  });

  it("builds one Autonomous manifest with transition IDs unique across routines", () => {
    const p = twoRoutines();
    const manifest = autonomousManifest(p)!;
    expect(() => parseMachineManifest(manifest)).not.toThrow();
    expect(manifest.id).toBe("Autonomous");
    const ids = manifest.transitions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(qualifiedTransitionId("second", p.routines[1].transitions[0].id));
    expect(ids[0]).toBe(`collect-score/${p.routines[0].transitions[0].id}`);
    // Shared node IDs are one state.
    expect(manifest.states.length).toBe(p.routines[0].nodes.length);
    expect(manifest.inputs).toEqual(p.signals);
    const cpp = exportCpp(p);
    expect(JSON.parse(manifestText(cpp, "autonomous"))).toEqual(manifest);
    expect(autonomousManifest({ ...p, routines: [] })).toBeUndefined();
  });

  it("is deterministic: same bytes for revision bumps and reordered keys", () => {
    const p = twoRoutines();
    const first = exportCpp(p);
    expect(exportCpp(structuredClone(p))).toBe(first);
    expect(exportCpp({ ...structuredClone(p), revision: p.revision + 41 })).toBe(first);
    expect(exportCpp(parseProject(JSON.stringify(reverseKeys(p))))).toBe(first);
    expect(first).not.toMatch(/revision/);
  });

  it("splits large manifests into literals MSVC accepts", () => {
    const p = load();
    const big = structuredClone(exampleMachine);
    big.states.forEach((s) => (s.description = "Long description · ".repeat(2500)));
    (p.extensions as any).machines = [big];
    const cpp = exportCpp(p);
    const text = manifestText(cpp, "machine_0");
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(70_000);
    expect(JSON.parse(text)).toEqual(big);
    const block = cpp.split("manifestParts = {{")[1].split("}};")[0];
    for (const line of block.trim().split("\n")) expect(line.length).toBeLessThan(16_000);
  });

  it("rejects invalid or conflicting machines with their index", () => {
    const p = load();
    (p.extensions as any).machines = [exampleMachine, { ...exampleMachine, initial: "Nope" }];
    expect(() => exportCpp(p)).toThrow(/extensions\.machines\[1\].*initial/);
    (p.extensions as any).machines = [exampleMachine, exampleMachine];
    expect(() => exportCpp(p)).toThrow(/machines\[1\].*not unique/);
    (p.extensions as any).machines = [{ ...exampleMachine, id: "Autonomous" }];
    expect(() => exportCpp(p)).toThrow(/not unique/);
    (p.extensions as any).machines = {};
    expect(() => exportCpp(p)).toThrow(/must be an array/);
    // Machine IDs that are not C++ identifiers get no alias but still export.
    (p.extensions as any).machines = [{ ...exampleMachine, id: "intake-seq" }, { ...exampleMachine, id: "class" }];
    const cpp = exportCpp(p);
    expect(cpp).toContain("namespace machine_1 {");
    expect(cpp).not.toMatch(/namespace (intake-seq|class) =/);
  });

  it("keeps the checked-in example header current (CLI --out/--check, quiet stderr)", () => {
    const header = resolve(root, "examples/suite/competition.hpp");
    const check = spawnSync(process.execPath, [script, "cpp", example, "--check", header], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const out = resolve(dir, "nested/autos.hpp");
    const write = spawnSync(process.execPath, [script, "cpp", example, "--out", out], { encoding: "utf8" });
    expect([write.status, write.stderr, write.stdout]).toEqual([0, "", ""]);
    expect(readFileSync(out, "utf8")).toBe(exportCpp(load()));
    const stdout = spawnSync(process.execPath, [script, "cpp", example], { encoding: "utf8" });
    expect([stdout.stdout, stdout.stderr]).toEqual([readFileSync(out, "utf8"), ""]);
    // CRLF checkouts still pass; real drift fails with a regenerate command.
    writeFileSync(out, readFileSync(out, "utf8").replace(/\n/g, "\r\n"));
    expect(spawnSync(process.execPath, [script, "cpp", example, "--check", out]).status).toBe(0);
    writeFileSync(out, "// old\n");
    const stale = spawnSync(process.execPath, [script, "cpp", example, "--check", out], { encoding: "utf8" });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/is stale\. Regenerate: node scripts\/mayhem\.mjs cpp .* --out /);
    const missing = spawnSync(process.execPath, [script, "cpp", example, "--check", resolve(dir, "none.hpp")], { encoding: "utf8" });
    expect([missing.status, /is missing/.test(missing.stderr)]).toEqual([1, true]);
  });

  it("compiles and runs generated machines with mayhem::StateMachine", () => {
    const p = twoRoutines();
    (p.extensions as any).machines = [
      {
        ...exampleMachine,
        id: "Shooter",
        inputs: [...exampleMachine.inputs, { key: "stateTime", name: "Seconds in state", type: "number", initial: 0 }],
        transitions: [
          ...exampleMachine.transitions,
          { id: "stuck", from: "Acquiring", to: "Idle", condition: { kind: "signal", key: "stateTime", op: "gt", value: 0.51 } },
        ],
      },
    ];
    writeFileSync(resolve(dir, "robot.hpp"), exportCpp(p));
    writeFileSync(
      resolve(dir, "main.cpp"),
      `#include "robot.hpp"
#include <cstdio>
int main() {
  bool requested = true;
  mayhem::StateMachine m(mayhem_generated::Shooter::machine, [&](std::string_view k) -> mayhem::SignalValue {
    if (k == "intake.requested") return requested; return {}; });
  m.Tick(.02); requested = false;
  int ticks = 0; while (m.State() == "Acquiring" && ticks < 100) { m.Tick(.02); ++ticks; }
  std::printf("%s %d %zu %s\\n", std::string(m.State()).c_str(), ticks, mayhem_generated::routines.size(),
              std::string(mayhem_generated::routines[1].name).c_str());
}`,
    );
    const exe = resolve(dir, "machine");
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", `-I${resolve(root, "lib-cpp/include")}`,
      resolve(dir, "main.cpp"), "-o", exe,
    ]);
    // 0.51 s deadline from the built-in stateTime: the 26th 20 ms tick (0.52 s) exceeds it.
    expect(execFileSync(exe, { encoding: "utf8" }).trim()).toBe("Idle 26 2 Second auto");
  });

  it("exports from \"*\" transitions with except, keeping priority per state", () => {
    const p = load();
    const sig = (key: string) => ({ kind: "signal" as const, key, op: "eq" as const, value: true });
    (p.extensions as any).machines = [
      {
        format: "mayhem-machine", version: 1, id: "Super", name: "Super", initial: "IDLE",
        states: ["IDLE", "SHOOT", "INTAKE", "HOME"].map((id) => ({ id, name: id })),
        inputs: ["home", "shoot", "intake", "idle"].map((key) => ({ key, name: key, type: "boolean", initial: false })),
        transitions: [
          { id: "toHome", from: "*", to: "HOME", condition: sig("home") },
          { id: "toShoot", from: "*", to: "SHOOT", except: ["HOME"], condition: sig("shoot") },
          { id: "intake", from: "IDLE", to: "INTAKE", condition: sig("intake") },
          { id: "toIdle", from: "*", to: "IDLE", condition: sig("idle") },
        ],
      },
    ];
    const cpp = exportCpp(p);
    expect(cpp).toContain('{"toHome","*","HOME",guard_0}');
    expect(cpp).toContain('{"toShoot","*","SHOOT",guard_1,except_1.data(),except_1.size()}');
    writeFileSync(resolve(dir, "super.hpp"), cpp);
    writeFileSync(
      resolve(dir, "super.cpp"),
      `#include "super.hpp"
#include <cstdio>
#include <set>
#include <string>
int main() {
  std::set<std::string> on;
  mayhem::StateMachine m(mayhem_generated::Super::machine, [&](std::string_view k) -> mayhem::SignalValue {
    return on.count(std::string(k)) > 0; });
  std::string trace = std::string(m.Valid() ? "valid" : "invalid");
  auto step = [&](std::set<std::string> next) { on = next; m.Tick(.02); trace += " " + std::string(m.State()); };
  step({"shoot", "intake"}); step({"shoot"}); step({"home", "shoot"}); step({"shoot", "idle"});
  std::printf("%s\\n", trace.c_str());
}`,
    );
    const exe = resolve(dir, "super");
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", `-I${resolve(root, "lib-cpp/include")}`,
      resolve(dir, "super.cpp"), "-o", exe,
    ]);
    // shoot beats intake from IDLE; SHOOT stays; home wins; from HOME toShoot is excepted.
    expect(execFileSync(exe, { encoding: "utf8" }).trim()).toBe("valid SHOOT SHOOT HOME IDLE");
  });

  // Two mode machines shaped like the 3256 robot's, with one-shot presses marked as events.
  const sig = (key: string, value: boolean | number | string = true, op: "eq" | "gt" | "lt" = "eq") => ({ kind: "signal" as const, key, op, value });
  const all = (...conditions: any[]) => ({ kind: "all" as const, conditions });
  const any = (...conditions: any[]) => ({ kind: "any" as const, conditions });
  const bool = (key: string, extra: object = {}) => ({ key, name: key, type: "boolean" as const, initial: false, ...extra });
  const modeMachines = (): MachineManifest[] => [
    {
      format: "mayhem-machine", version: 1, id: "ShooterMode", name: "Shooter mode", initial: "OFF",
      states: ["OFF", "REV", "SHOOTING"].map((id) => ({ id, name: id })),
      inputs: [bool("enabled"), bool("stopAll", { event: true }), bool("shootHeld"), bool("inAllianceZone"),
        { key: "shot.distance", name: "Shot distance", type: "number", initial: 3.5, unit: "m", category: "sensor" },
        { key: "mode", name: "Mode", type: "string", initial: "hub" }],
      transitions: [
        { id: "stop", from: "*", to: "OFF", condition: any(sig("enabled", false), sig("stopAll")) },
        { id: "shoot", from: "OFF", to: "SHOOTING", condition: all(sig("shootHeld"), sig("shot.distance", 6, "lt"), sig("mode", "hub")) },
        { id: "revShoot", from: "REV", to: "SHOOTING", condition: sig("shootHeld") },
        { id: "released", from: "SHOOTING", to: "OFF", condition: sig("shootHeld", false) },
        { id: "zone", from: "OFF", to: "REV", condition: all(sig("enabled"), sig("inAllianceZone")) },
        { id: "leftZone", from: "REV", to: "OFF", condition: sig("inAllianceZone", false) },
      ],
    },
    {
      format: "mayhem-machine", version: 1, id: "IntakeMode", name: "Intake mode", initial: "STOWED",
      states: ["STOWED", "INTAKING", "default"].map((id) => ({ id, name: id })),
      inputs: [bool("enabled"), bool("intakePressed", { event: true, category: "operator" }),
        { key: "stateTime", name: "Seconds in state", type: "number", initial: 0, category: "timer" }],
      transitions: [
        { id: "on", from: "STOWED", to: "INTAKING", condition: all(sig("enabled"), sig("intakePressed")) },
        { id: "off", from: "INTAKING", to: "STOWED", condition: sig("intakePressed") },
        { id: "stale", from: "INTAKING", to: "default", condition: sig("stateTime", 2, "gt") },
      ],
    },
  ];
  const compile = (name: string, code: string, header: string) => {
    writeFileSync(resolve(dir, `${name}.hpp`), header);
    writeFileSync(resolve(dir, `${name}.cpp`), code.replace("HEADER", `${name}.hpp`));
    return spawnSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", `-I${resolve(root, "lib-cpp/include")}`,
      resolve(dir, `${name}.cpp`), "-o", resolve(dir, name),
    ], { encoding: "utf8" });
  };

  it("names typed members after manifest IDs, as valid unique C++ identifiers", () => {
    expect(cppIdentifiers(["shootHeld", "intake.requested", "intake-requested", "2fast", "default", "_x", "a__b", "NULL"])).toEqual([
      "shootHeld", "intake_requested", "intake_requested_2", "k2fast", "default_", "k_x", "a_b", "NULL_",
    ]);
  });

  it("exports a typed machine API whose guards read an Inputs struct and settle like the robot", () => {
    const p = load();
    (p.extensions as any).machines = modeMachines();
    const cpp = exportCpp(p);
    expect(cpp).toContain("enum class State : int { OFF, REV, SHOOTING };");
    expect(cpp).toContain("  double shot_distance = 3.5; // \"shot.distance\" · Shot distance · sensor");
    expect(cpp).toContain("  std::string mode = \"hub\";");
    expect(cpp).toContain("  bool intakePressed = false; // operator · event: reset after the first step of each loop");
    expect(cpp).toContain('{"stopAll","",mayhem::InputType::Boolean,true,mayhem::SignalValue{false}}');
    expect(cpp).toContain("mayhem::CompareTyped(in.shootHeld, mayhem::CompareOp::Eq, true)");
    expect(cpp).toContain("mayhem::CompareTyped(stateTime, mayhem::CompareOp::Gt, double{2})");
    expect(cpp).toContain("mayhem::CompareTyped(std::string_view{in.mode}, mayhem::CompareOp::Eq, std::string_view{\"hub\"})");
    expect(cpp).toContain("enum class State : int { STOWED, INTAKING, default_ };");
    expect(cpp).not.toMatch(/double stateTime =/);  // built in
    expect(cpp).toContain("using Machine = mayhem::TypedMachine<Def>;");
    const run = compile("typed", `#include "HEADER"
#include <cstdio>
#include <string>
namespace gen = mayhem_generated;
int main() {
  gen::ShooterMode::Machine shooter;
  gen::IntakeMode::Machine intake;
  using Shot = gen::ShooterMode::State;
  using Intake = gen::IntakeMode::State;
  std::string trace;
  auto& in = shooter.In();
  in.enabled = true; in.inAllianceZone = true; in.shootHeld = true;
  trace += std::to_string(shooter.Settle(.02)) + std::string(shooter.StateName()) + " ";
  in.shootHeld = false;  // A released inside the alliance zone: SHOOTING, OFF, then REV in one loop
  trace += std::to_string(shooter.Settle(.02)) + std::string(shooter.StateName()) + (shooter.Is(Shot::REV) ? "! " : "? ");
  in.stopAll = true;  // one-loop request: OFF, then (stopAll used up) the zone check revs again
  trace += std::to_string(shooter.Settle(.02)) + std::string(shooter.StateName()) + (in.stopAll ? "1 " : "0 ");
  trace += std::to_string(shooter.Settle(.02)) + std::string(shooter.StateName()) + " ";
  intake.In().enabled = true;
  intake.In().intakePressed = true;  // X: on once, not on and off again
  trace += std::to_string(intake.Settle(.02)) + std::string(intake.StateName()) + " ";
  trace += std::to_string(intake.Settle(.02)) + std::string(intake.StateName()) + " ";
  intake.In().intakePressed = true;
  trace += std::to_string(intake.Settle(.02)) + std::string(intake.StateName()) + " ";
  intake.In().intakePressed = true; intake.Settle(.02);
  trace += std::to_string(intake.Settle(2.1)) + std::string(gen::IntakeMode::Machine::Name(intake.Current()));
  std::printf("%s %d\\n", trace.c_str(), intake.Is(Intake::default_));
}`, cpp);
    expect(run.stderr).toBe("");
    expect(execFileSync(resolve(dir, "typed"), { encoding: "utf8" }).trim()).toBe("1SHOOTING 2REV! 2REV0 0REV 1INTAKING 0INTAKING 1STOWED 1default 1");
    // The same loop in the editor's settle (states page, simulation).
    const [shooterManifest] = modeMachines();
    expect(settleMachine(shooterManifest, "SHOOTING", { enabled: true, inAllianceZone: true, shootHeld: false, stopAll: false, "shot.distance": 3, mode: "hub" }))
      .toEqual({ state: "REV", path: ["SHOOTING", "OFF", "REV"], settled: true });
  });

  it("turns a misspelled input or state into a compile error", () => {
    const p = load();
    (p.extensions as any).machines = modeMachines();
    const cpp = exportCpp(p);
    const body = (line: string) => `#include "HEADER"
int main() { mayhem_generated::ShooterMode::Machine m; ${line} return 0; }`;
    expect(compile("ok", body("m.In().shootHeld = true; (void)m.Is(mayhem_generated::ShooterMode::State::REV);"), cpp).status).toBe(0);
    const input = compile("badInput", body("m.In().shootHled = true;"), cpp);
    expect(input.status).not.toBe(0);
    expect(input.stderr).toMatch(/shootHled/);
    const state = compile("badState", body("(void)m.Is(mayhem_generated::ShooterMode::State::SHOTING);"), cpp);
    expect(state.status).not.toBe(0);
    expect(state.stderr).toMatch(/SHOTING/);
  });

  it("validates event inputs and settles events in the editor like mayhem::StateMachine::Settle", () => {
    const [, intake] = modeMachines();
    expect(() => parseMachineManifest({ ...intake, inputs: [{ ...intake.inputs[1], event: "yes" }, intake.inputs[0], intake.inputs[2]] })).toThrow(/Invalid machine input/);
    const pressed = { enabled: true, intakePressed: true, stateTime: 0 };
    expect(settleMachine(intake, "STOWED", pressed)).toEqual({ state: "INTAKING", path: ["STOWED", "INTAKING"], settled: true });
    // Without the event flag the press is seen again and toggles straight back off.
    const level = { ...intake, inputs: intake.inputs.map((i) => ({ ...i, event: undefined })) };
    expect(settleMachine(level, "STOWED", pressed, 3)).toEqual({ state: "INTAKING", path: ["STOWED", "INTAKING", "STOWED", "INTAKING"], settled: false });
  });

  it("exports onTimeout, guard signal keys and the path preview, and runs with AutoRunner bindings", () => {
    const p = load();
    const r = p.routines[0];
    r.nodes.find((n) => n.id === "shoot")!.onTimeout = "succeed";
    r.nodes.find((n) => n.id === "shoot")!.timeout = 1.5;
    const cpp = exportCpp(p);
    expect(cpp).toMatch(/\{"shoot",mayhem::NodeKind::Action,.*,mayhem::TimeoutOutcome::Succeed\}/);
    expect(cpp).not.toMatch(/\{"collect",mayhem::NodeKind::Action,.*TimeoutOutcome/);
    expect(cpp).toContain('inline constexpr std::array<std::string_view,3> signalKeys = {{\n  "pieceDetected",\n  "shooterReady",\n  "shotComplete",\n}};');
    expect(cpp).toContain("transitions.data(),transitions.size(),signalKeys.data(),signalKeys.size()};");
    expect(cpp).toContain("inline constexpr mayhem::RoutineInfo info{name,routine,startPose,preview.data(),preview.size()};");
    // The preview follows the editor's path-only playback: from the start to the last pose step,
    // along curves rather than straight lines between steps.
    const preview = previewPath(p, r);
    expect(preview[0]).toEqual(r.start ?? p.robot.start);
    expect(preview.at(-1)).toEqual({ x: 3.2, y: 5.6, heading: 1.1 });
    const goals = r.nodes.filter((n) => n.kind === "pose").map((n) => n.goal!);
    const offLine = preview.filter((q) => goals.every((g, i) => {
      const a = i ? goals[i - 1] : preview[0], dx = g.x - a.x, dy = g.y - a.y, len = Math.hypot(dx, dy) || 1;
      return Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / len > 0.05;
    }));
    expect(offLine.length).toBeGreaterThan(3);
    for (let i = 1; i < preview.length; i++) expect(Math.hypot(preview[i].x - preview[i - 1].x, preview[i].y - preview[i - 1].y)).toBeLessThan(0.2);
    expect(exportCpp(p)).toBe(cpp);  // deterministic
    const run = compile("bound", `#include "HEADER"
#include "mayhem/alliance.hpp"
#include <cstdio>
#include <string>
namespace gen = mayhem_generated;
static double now = 0;
int main() {
  mayhem::AllianceRoutine routine(gen::routine_0::info, gen::fieldLength, gen::fieldWidth, mayhem::FieldTransform::Flip);
  mayhem::AutoRunner runner(routine.View());
  std::string report = runner.UnboundReport();
  int fireTicks = 0;
  bool piece = false;
  runner.Bind("intake.acquire", mayhem::Instant([&] { piece = true; }))
        .Bind("shooter.fire", {nullptr, [&] { ++fireTicks; return mayhem::ActionStatus::Running; }, nullptr})
        .BindSignal("pieceDetected", [&] { return mayhem::SignalValue{piece}; })
        .BindSignal("shooterReady", [] { return mayhem::SignalValue{true}; })
        .BindSignal("shotComplete", [] { return mayhem::SignalValue{true}; });
  runner.SetClock([] { return now; });
  mayhem::Pose pose = routine.StartPose(); mayhem::Velocity v;
  runner.Start();
  while (runner.Status() == mayhem::RunStatus::Running && now < 30) {
    now += .02; v = runner.Tick(pose, v);
    pose.x += v.vx * .02; pose.y += v.vy * .02; pose.heading = mayhem::Wrap(pose.heading + v.omega * .02);
  }
  const auto& end = routine.Preview().back();
  std::printf("%s|%d %d %zu %.2f %.2f\\n", report.c_str(), runner.Status() == mayhem::RunStatus::Completed, fireTicks > 60,
              runner.Unbound().size(), end.x - pose.x, end.y - pose.y);
}`, cpp);
    expect(run.stderr).toBe("");
    const out = execFileSync(resolve(dir, "bound"), { encoding: "utf8" });
    expect(out.split("|")[0]).toBe("action intake.acquire (node collect)\naction shooter.fire (node shoot)\nsignal pieceDetected\nsignal shooterReady\nsignal shotComplete\n");
    // Completes through the 1.5 s shot window; the red preview ends where the robot ends.
    expect(out.split("|")[1].trim()).toMatch(/^1 1 0 -?0\.0\d -?0\.0\d$/);
  });
});
