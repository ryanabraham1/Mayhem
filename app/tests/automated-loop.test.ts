import { describe, expect, it } from "vitest";
import { checkMachines } from "../src/suite/core/review/modelcheck";
import { scenarioCoverage } from "../src/suite/core/review/coverage";
import type { MachineManifest } from "../src/suite/core/machines";
import type { Condition } from "../src/suite/core/model";
// @ts-expect-error plain ES module without types
import { lintFiles } from "../../scripts/lint.mjs";
// @ts-expect-error plain ES module without types
import { agentPrompt, classify, findingsOf, modelFindings, reportText } from "../../scripts/factory.mjs";

const sig = (key: string, value: boolean | number | string = true, op: "eq" | "gt" | "lt" = "eq"): Condition => ({ kind: "signal", key, op, value });
const machine = (over: Partial<MachineManifest>): MachineManifest =>
  ({
    format: "mayhem-machine",
    version: 1,
    id: "ee",
    name: "End effector",
    initial: "IDLE",
    states: [
      { id: "IDLE", name: "Idle" },
      { id: "EJECT", name: "Ejecting" },
    ],
    inputs: [
      { key: "ejectHeld", name: "Eject (RS)", type: "boolean", initial: false, category: "operator" },
      { key: "enabled", name: "Enabled", type: "boolean", initial: true },
    ],
    transitions: [],
    ...over,
  }) as MachineManifest;

describe("model check", () => {
  it("finds the loop a held button causes while disabled, with the inputs that cause it", () => {
    const m = machine({
      transitions: [
        { id: "eject", from: "IDLE", to: "EJECT", condition: sig("ejectHeld") },
        { id: "disabled", from: "EJECT", to: "IDLE", condition: sig("enabled", false) },
      ],
    });
    const r = checkMachines([m]);
    const loops = r.problems.filter((p) => p.kind === "loops");
    expect(loops).toHaveLength(1);
    expect(loops[0].inputs).toEqual({ ejectHeld: true, enabled: false });
    // Fixed: the eject edge also needs the robot enabled.
    m.transitions[0].condition = { kind: "all", conditions: [sig("ejectHeld"), sig("enabled")] };
    expect(checkMachines([m]).problems.filter((p) => p.kind === "loops")).toEqual([]);
  });

  it("finds unreachable states, traps, shadowed transitions and unknown inputs", () => {
    const m = machine({
      states: [
        { id: "IDLE", name: "Idle" },
        { id: "EJECT", name: "Ejecting" },
        { id: "STUCK", name: "Stuck" },
        { id: "LOST", name: "Lost" },
      ],
      transitions: [
        { id: "any", from: "IDLE", to: "EJECT", name: "Anything", condition: { kind: "always" } },
        { id: "eject", from: "IDLE", to: "STUCK", name: "Eject", condition: sig("ejectHeld") },
        { id: "back", from: "EJECT", to: "IDLE", condition: sig("enabled", false) },
        { id: "typo", from: "EJECT", to: "STUCK", name: "Typo", condition: sig("ejectHled") },
      ],
    });
    const kinds = checkMachines([m]).problems.map((p) => `${p.kind} ${p.state ?? p.transition}`);
    expect(kinds).toContain("unknown-input Typo");
    expect(kinds).toContain("never-fires Eject");
    expect(kinds).toContain("unreachable STUCK");
    expect(kinds).toContain("unreachable LOST");
    const shadow = checkMachines([m]).problems.find((p) => p.transition === "Eject")!;
    expect(shadow.text).toMatch(/“Anything” comes first in priority order/);
  });

  it("splits numbers at each threshold, so a gap between thresholds is found", () => {
    const m = machine({
      inputs: [{ key: "speed", name: "Speed", type: "number", initial: 0 }],
      transitions: [
        { id: "fast", from: "IDLE", to: "EJECT", condition: sig("speed", 10, "gt") },
        { id: "slow", from: "EJECT", to: "IDLE", condition: sig("speed", 5, "lt") },
      ],
    });
    expect(checkMachines([m]).problems).toEqual([]);
    // Overlapping thresholds: at 7 both are true, and it flips every loop.
    m.transitions[1].condition = sig("speed", 12, "lt");
    const loop = checkMachines([m]).problems.find((p) => p.kind === "loops");
    expect(loop?.inputs?.speed).toBeGreaterThan(10);
    expect(loop?.inputs?.speed).toBeLessThan(12);
  });

  it("treats a priority supervisor's rows as deciding even when they keep the state", () => {
    const m = machine({
      selection: "priority",
      transitions: [
        { id: "off", from: "*", to: "IDLE", condition: sig("enabled", false) },
        { id: "eject", from: "*", to: "EJECT", condition: sig("ejectHeld") },
        { id: "otherwise", from: "*", to: "IDLE", condition: { kind: "always" } },
      ],
    });
    expect(checkMachines([m]).problems).toEqual([]);
  });
});

describe("feature map", () => {
  it("lists every state with how it is reached and what proves it", () => {
    const m = machine({ transitions: [{ id: "eject", from: "IDLE", to: "EJECT", condition: sig("ejectHeld") }] });
    const run = (name: string, expect: string[]) => ({
      scenario: { id: name, name, group: "custom" as const, alliance: "blue" as const, field: true, steps: ["teleop", "hold RS 1"], expect },
      after: { tracks: [{ name: "End effector", channel: "x", changes: [{ time: 0, value: "IDLE" }, { time: 0.4, value: "EJECT" }] }], poses: [], offset: 0, duration: 2 },
    });
    const c = scenarioCoverage([m], [run("Eject", ["End effector reaches EJECT"]), run("Eject again", [])]);
    expect(c.map).toEqual([
      { machine: "End effector", state: "EJECT", name: "Ejecting", status: "proven", reachedBy: { scenario: "Eject", steps: ["teleop", "hold RS 1"], time: 0.4 }, provenBy: ["Eject"] },
    ]);
  });
});

describe("lint", () => {
  const lint = (path: string, text = "") => lintFiles([{ path, text }]).map((p: { rule: string }) => p.rule);
  it("keeps core portable and the synced log core standalone", () => {
    expect(lint("app/src/suite/core/x.ts", 'import { FieldArt } from "../FieldArt";')).toEqual(["core-is-portable"]);
    expect(lint("app/src/suite/core/x.ts", 'import { memo } from "react";')).toEqual(["core-is-portable"]);
    expect(lint("app/src/suite/core/review/x.ts", 'import { a } from "../model.ts";')).toEqual([]);
    expect(lint("app/src/suite/core/plot.ts", 'import { a } from "./model.ts";')).toEqual(["log-core-standalone"]);
    expect(lint("app/src/suite/core/plot.ts", 'import { a } from "./analysis.ts";')).toEqual([]);
    expect(lint("scripts/x.mjs", 'await import("../app/src/suite/logs/LogsPage.tsx")')).toEqual(["scripts-use-core"]);
  });
  it("flags deferred quick fixes and the comments that justify them", () => {
    expect(lint("app/src/suite/x.ts", "// release later, in case it comes back\nsetTimeout(() => release(id), 0);")).toEqual(["no-deferred-fix", "no-workaround-comments"]);
    expect(lint("app/src/suite/x.ts", "setTimeout(() => save(), 500);")).toEqual([]);
    expect(lint("app/src/suite/x.ts", "// hack: for now skip the check")).toEqual(["no-workaround-comments"]);
  });
  it("flags focused tests and unsolicited markdown", () => {
    expect(lint("app/tests/a.test.ts", `it.${"only"}("x", () => {});`)).toEqual(["no-focused-tests"]);
    expect(lint("app/e2e/a.spec.ts", 'test.skip(!repo, "needs a robot repo");')).toEqual([]);
    expect(lint("NOTES.md")).toEqual(["no-unsolicited-markdown"]);
    expect(lint("app/src/suite/PLAN.md")).toEqual(["no-unsolicited-markdown"]);
    expect(lint("docs/NEW_PAGE.md")).toEqual([]);
    expect(lint("lib-cpp/README.md")).toEqual([]);
  });
});

describe("factory", () => {
  const sim = {
    results: [
      { scenario: "L4: arm up and hold", failed: true, checks: [{ text: "ArmSequence is HOLDING by 2.0 s", pass: false, detail: "Never reached HOLDING" }], logs: { before: "b1", after: "a1" } },
      { scenario: "Tap Y", logs: { before: "b2", after: "a2" } },
    ],
  };
  const diagnose = async (log: string) => ({
    findings: [
      { id: "alert:Swerve CANcoder [2] is disconnected.", kind: "alert", severity: "error", title: "Alert", detail: "sim" },
      ...(log.startsWith("a") ? [{ id: "state-flicker:Mayhem/States/ee/state", kind: "state-flicker", severity: "error", title: "End effector flickers", detail: "…", next: { tool: "log_states" } }] : []),
      { id: "loop", kind: "loop-overrun", severity: "info", title: "", detail: "" },
    ],
  });

  it("sorts what's wrong on main into NEW and PRE-EXISTING against the baseline", async () => {
    const now = await findingsOf(sim, "after", diagnose, ["disconnected"]);
    const before = await findingsOf(sim, "before", diagnose, ["disconnected"]);
    expect(now.map((f: { id: string }) => f.id)).toEqual(["scenario:L4: arm up and hold", "diagnose:state-flicker:Mayhem/States/ee/state"]);
    expect(now[1].scenarios).toEqual(["L4: arm up and hold", "Tap Y"]);
    const sorted = classify([...now, ...modelFindings([{ id: "loops:ee:EJECT+IDLE", kind: "loops", machine: "End effector", text: "End effector: flickers", inputs: { ejectHeld: true } }])], [...before, ...modelFindings([{ id: "loops:ee:EJECT+IDLE", kind: "loops", machine: "End effector", text: "End effector: flickers" }])]);
    expect(sorted.new.map((f: { id: string }) => f.id)).toEqual(["scenario:L4: arm up and hold", "diagnose:state-flicker:Mayhem/States/ee/state"]);
    expect(sorted.existing.map((f: { id: string }) => f.id)).toEqual(["model:loops:ee:EJECT+IDLE"]);
    const text = reportText({ repo: "/r/robot", main: "abcdef123", baseline: { rev: "x", label: "v1.2" }, sorted, dispatched: [{ finding: sorted.new[0], branch: "factory/x", status: "ready" }] });
    expect(text).toContain("compared every finding with v1.2");
    expect(text).toContain("NEW: 2 (2 high, 0 medium, 0 low). PRE-EXISTING: 1 (1 high, 0 medium, 0 low).");
    expect(text.indexOf("[NEW]")).toBeLessThan(text.indexOf("[PRE-EXISTING]"));
    expect(text).toContain("Agent: ready on `factory/x`");
  });

  it("without a baseline everything is new", () => {
    const f = { id: "a", severity: "medium", scenarios: [] };
    expect(classify([f], undefined)).toEqual({ new: [f], existing: [], fixed: [] });
  });

  it("tells the agent to reproduce first, then pass the gate, and never weaken scenarios", () => {
    const prompt = agentPrompt({ id: "scenario:x", title: "x fails", severity: "high", detail: "", scenarios: ["x"] }, { repo: "/r", base: "main" });
    expect(prompt).toMatch(/still-failing/);
    expect(prompt).toMatch(/red-green/);
    expect(prompt).toMatch(/verify \. HEAD --base main/);
    expect(prompt).toMatch(/Never: remove or loosen an existing scenario/);
  });
});

describe("factory run (fake agent, fake sim)", () => {
  it("dispatches one agent per cause, verifies it itself, and doesn't send another for what that branch fixes", async () => {
    const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    // @ts-expect-error plain ES module without types
    const { runFactory } = await import("../../scripts/factory.mjs");
    const root = await mkdtemp(join(tmpdir(), "factory-"));
    const home = join(root, "home");
    const repo = join(root, "robot");
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    const sha = g("rev-parse", "HEAD");
    // The "agent": commits a fix on its branch and reports a session.
    const agent = join(root, "agent.sh");
    await writeFile(agent, '#!/bin/sh\ngit -c user.name=a -c user.email=a@a commit -q --allow-empty -m fix\necho \'{"session_id":"s1","result":"fixed"}\'\n');
    await chmod(agent, 0o755);
    const verified: string[] = [];
    const deps = {
      mainRef: async () => ({ rev: "main", sha }),
      gitShow: async () => undefined,
      modelDiff: () => ({ new: [], fixed: [], existing: [] }),
      diagnose: async () => ({ findings: [] }),
      runScenarios: async () => ({
        results: [
          { scenario: "L4 hold", failed: true, checks: [], logs: {} },
          { scenario: "L4 score", failed: true, checks: [], logs: {} },
        ],
      }),
      verifyChange: async (a: { repo: string }) => {
        verified.push(a.repo);
        return { ready: true, reasons: [], warnings: [], tests: [], fixes: ["L4 hold", "L4 score"] };
      },
    };
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = await runFactory(deps, { repo, agent, baseline: "HEAD" }, () => {});
      expect(first.dispatched.map((d: { status: string }) => d.status)).toEqual(["ready", "covered"]);
      expect(first.dispatched[1].branch).toBe(first.dispatched[0].branch);
      expect(verified).toHaveLength(1); // the factory ran the gate itself
      expect(g("log", "--oneline", `main..${first.dispatched[0].branch}`)).toMatch(/fix/);
      expect(g("worktree", "list")).not.toMatch(/worktrees/); // cleaned up, branch kept
      // Next run (main still broken): both findings are covered by the open branch.
      const second = await runFactory(deps, { repo, agent, baseline: "HEAD" }, () => {});
      expect(second.dispatched.map((d: { status: string }) => d.status)).toEqual(["covered", "covered"]);
      expect(verified).toHaveLength(1);
      // Once the branch is deleted (merged or rejected), the finding is fair game again.
      g("branch", "-D", first.dispatched[0].branch);
      const third = await runFactory(deps, { repo, agent, baseline: "HEAD", max: 1 }, () => {});
      expect(third.dispatched.map((d: { status: string }) => d.status)).toEqual(["ready", "covered"]);
    } finally {
      process.env.HOME = before;
    }
  }, 30_000);
});
