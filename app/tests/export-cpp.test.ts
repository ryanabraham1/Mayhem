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
  exportCpp,
  qualifiedTransitionId,
} from "../src/suite/core/export-cpp.ts";
import { exampleMachine, parseMachineManifest } from "../src/suite/core/machines.ts";
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
    expect(cpp).toContain("inline constexpr mayhem::MachineView machine{id,\"Idle\",states.data(),states.size(),transitions.data(),transitions.size(),manifest};");
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
});
