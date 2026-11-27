import { describe, expect, it } from "vitest";
import { runSimProof, scenarioTests, summarizeProof, type SimRunner } from "../src/suite/core/review/simproof";
import { parseProofNote, proofText, withProof } from "../src/suite/core/review/proofs";
import { scenarioCoverage } from "../src/suite/core/review/coverage";
import type { MachineManifest } from "../src/suite/core/machines";
import type { Outcome, Scenario } from "../src/suite/core/review/scenarios";

const machine: MachineManifest = {
  format: "mayhem-machine",
  version: 1,
  id: "shooter",
  name: "Shooter",
  initial: "IDLE",
  states: [
    { id: "IDLE", name: "Idle" },
    { id: "SPINUP", name: "Spin up" },
    { id: "SHOOT", name: "Shoot" },
    { id: "JAMMED", name: "Jammed" },
  ],
  transitions: [
    { id: "spin", from: "IDLE", to: "SPINUP", name: "Shoot held", condition: { kind: "signal", key: "shoot", op: "eq", value: true } },
    { id: "fire", from: "SPINUP", to: "SHOOT", condition: { kind: "all", conditions: [{ kind: "signal", key: "atSpeed", op: "eq", value: true }, { kind: "signal", key: "shoot", op: "eq", value: true }] } },
    { id: "jam", from: "*", to: "JAMMED", name: "Stalled", condition: { kind: "all", conditions: [{ kind: "signal", key: "stalled", op: "eq", value: true }, { kind: "signal", key: "stateTime", op: "gt", value: 0.5 }] } },
  ],
  inputs: [
    { key: "shoot", name: "Shoot (A)", type: "boolean", category: "operator" },
    { key: "atSpeed", name: "At speed", type: "boolean", category: "sensor" },
    { key: "stalled", name: "Stalled", type: "boolean", category: "sensor" },
  ],
} as MachineManifest;

const scenario = (name: string, expect: string[], group: Scenario["group"] = "custom"): Scenario => ({
  id: name,
  name,
  group,
  alliance: "blue",
  field: true,
  steps: ["teleop", "wait 1", "hold A 2"],
  expect,
});

const outcome = (changes: [number, string][]): Outcome => ({
  tracks: [{ name: "Shooter", channel: "/Mayhem/States/shooter/state", changes: changes.map(([time, value]) => ({ time, value })) }],
  poses: [],
  offset: 0,
  duration: 5,
});

/** A runner that "builds" two versions; each scenario's outcome per version comes from `runs`. */
function runner(runs: Record<string, Record<"before" | "after", Outcome | "crash">>): SimRunner {
  const outcomes = new Map<string, Outcome>();
  return {
    prepare: async (rev) => ({ dir: rev, cached: true }),
    async run(dir, id) {
      const o = runs[id][dir as "before" | "after"];
      if (o === "crash") return { ok: false, output: "segfault" };
      outcomes.set(`${dir}/${id}`, o);
      return { ok: true, log: `${dir}/${id}`, output: "" };
    },
    readLog: async (path) => ({ name: path, duration: 5, channels: [], warnings: [], __outcome: outcomes.get(path) }) as never,
  };
}

// outcomeOf reads machine tracks from the recording; feed it the outcome directly instead.
import * as scenarios from "../src/suite/core/review/scenarios";
import { vi } from "vitest";
vi.spyOn(scenarios, "outcomeOf").mockImplementation((recording) => (recording as never as { __outcome: Outcome }).__outcome);

describe("red → green scenario verdicts", () => {
  const shootsByTwo = scenario("Hold A shoots", ["Shooter is SHOOT by 2 s"]);
  const neverJams = scenario("Holding A never jams", ["Shooter never JAMMED"]);
  const spins = scenario("Hold A spins up", ["Shooter reaches SPINUP"]);
  const broken = scenario("Old guard", ["Shooter reaches SPINUP"]);
  const crashBefore = scenario("New feature", ["Shooter reaches SHOOT"]);
  const runs = {
    [shootsByTwo.id]: { before: outcome([[0, "IDLE"], [1.1, "SPINUP"], [2.6, "SHOOT"]]), after: outcome([[0, "IDLE"], [1.1, "SPINUP"], [1.6, "SHOOT"]]) },
    [neverJams.id]: { before: outcome([[0, "IDLE"], [1.2, "JAMMED"]]), after: outcome([[0, "IDLE"], [1.2, "JAMMED"]]) },
    [spins.id]: { before: outcome([[0, "IDLE"], [1.1, "SPINUP"]]), after: outcome([[0, "IDLE"], [1.1, "SPINUP"]]) },
    [broken.id]: { before: outcome([[0, "IDLE"], [1.1, "SPINUP"]]), after: outcome([[0, "IDLE"]]) },
    [crashBefore.id]: { before: "crash" as const, after: outcome([[0, "IDLE"], [1.6, "SHOOT"]]) },
  };

  it("judges each new scenario by its run on both versions", async () => {
    const proof = await runSimProof(runner(runs), { before: "before", after: "after" }, [shootsByTwo, neverJams, spins, broken, crashBefore], [machine], () => {}, 2);
    const tests = scenarioTests(proof, [shootsByTwo.name, neverJams.name, spins.name, broken.name, crashBefore.name]);
    const verdict = Object.fromEntries(tests.map((t) => [t.scenario, t.verdict]));
    expect(verdict).toEqual({
      "Hold A shoots": "red-green",
      "Holding A never jams": "still-failing",
      "Hold A spins up": "passes-on-base",
      "Old guard": "breaks",
      "New feature": "red-green",
    });
    // What the scenario caught on the unfixed version, in the expectation's words.
    expect(tests.find((t) => t.scenario === "Hold A shoots")?.caught).toEqual(["Shooter is SHOOT by 2 s (Reached SHOOT at 2.60 s)"]);
    expect(tests.find((t) => t.scenario === "Holding A never jams")?.failing?.[0]).toMatch(/Entered JAMMED/);
    expect(tests.find((t) => t.scenario === "New feature")?.caught?.[0]).toMatch(/^Before:/);
  });

  it("only judges the scenarios a change adds or changes", async () => {
    const proof = await runSimProof(runner(runs), { before: "before", after: "after" }, [shootsByTwo, spins], [machine], () => {}, 2);
    expect(scenarioTests(proof, [spins.name]).map((t) => t.scenario)).toEqual(["Hold A spins up"]);
  });

  it("can't judge without a before version", async () => {
    const proof = await runSimProof(runner(runs), { after: "after" }, [shootsByTwo], [machine], () => {}, 2);
    expect(scenarioTests(proof, [shootsByTwo.name])[0].verdict).toBe("untested");
  });

  it("records which new scenarios reproduced the bug on the commit's proof", async () => {
    const proof = await runSimProof(runner(runs), { before: "before", after: "after" }, [shootsByTwo, spins], [machine], () => {}, 2);
    const tests = scenarioTests(proof, [shootsByTwo.name, spins.name]);
    const summary = { ...summarizeProof(proof, { by: "claude", before: "abc", tests }), at: "2026-11-26T00:00:00Z" };
    expect(summary.tests).toEqual({ reproduced: ["Hold A shoots"], passesOnBase: ["Hold A spins up"] });
    const [read] = parseProofNote(withProof(null, summary));
    expect(read.tests).toEqual(summary.tests);
    expect(proofText(read)).toBe("2 scenarios pass, 1 behaves differently; 1 new scenario fails before this change and passes with it");
    expect(proofText({ ...read, tests: { reproduced: [], passesOnBase: ["Hold A spins up"] } })).toMatch(/already passed before this change \(none shows a fix\)$/);
    expect(proofText({ ...read, tests: { reproduced: [], passesOnBase: [] } })).toMatch(/; no new scenario$/);
    // Older notes without tests read and print as before.
    const { tests: _, ...old } = read;
    expect(proofText(parseProofNote(withProof(null, old))[0])).toBe("2 scenarios pass, 1 behaves differently");
  });

  it("keeps tests off a proof that wasn't compared with anything", () => {
    const proof = { results: [], passed: true, changed: 0 };
    expect(summarizeProof(proof, { by: "claude", tests: [] }).tests).toBeUndefined();
  });
});

describe("scenario coverage", () => {
  it("lists states no scenario checks, with a draft from the run that reached them", () => {
    const results = [
      { scenario: scenario("Hold A for 2 s", [], "button"), after: outcome([[0, "IDLE"], [1.1, "SPINUP"], [1.64, "SHOOT"]]) },
      { scenario: scenario("Driver spins up", ["Shooter reaches SPINUP"]), after: outcome([[0, "IDLE"], [1.2, "SPINUP"]]) },
    ];
    const c = scenarioCoverage([machine], results);
    expect(c).toMatchObject({ states: 3, reached: 2, checked: 1 });
    // Never reached first, with how to get there.
    expect(c.gaps[0]).toEqual({
      machine: "Shooter",
      state: "JAMMED",
      kind: "unreached",
      enteredBy: [
        {
          transition: "Stalled",
          from: "*",
          inputs: [
            { key: "stalled", name: "Stalled", category: "sensor" },
            { key: "stateTime", name: "stateTime", category: "timer" },
          ],
        },
      ],
    });
    expect(c.gaps[1]).toEqual({
      machine: "Shooter",
      state: "SHOOT",
      kind: "unchecked",
      reachedBy: [{ scenario: "Hold A for 2 s", time: 1.64 }],
      draft: { name: "Hold A for 2 s: Shooter reaches Shoot", steps: ["teleop", "wait 1", "hold A 2"], expect: ["Shooter is SHOOT by 2 s"] },
    });
  });

  it("bases drafts on the team's own scenarios first", () => {
    const c = scenarioCoverage([machine], [
      { scenario: scenario("Hold A for 2 s", [], "button"), after: outcome([[0, "IDLE"], [1.1, "SPINUP"]]) },
      { scenario: scenario("Driver warms up", []), after: outcome([[0, "IDLE"], [1.5, "SPINUP"]]) },
    ]);
    expect(c.gaps.find((g) => g.state === "SPINUP")?.draft?.name).toBe("Driver warms up: Shooter reaches Spin up");
  });

  it("leaves out the state a machine boots in", () => {
    const c = scenarioCoverage([machine], [{ scenario: scenario("a", []), after: outcome([[0.02, "SPINUP"], [1, "IDLE"]]) }]);
    // SPINUP is only ever the boot state; SHOOT and JAMMED are never reached.
    expect(c.gaps.map((g) => `${g.state} ${g.kind}`)).toEqual(["SHOOT unreached", "JAMMED unreached"]);
    expect(c.states).toBe(2);
  });

  it("counts a state checked by name or id, but not by `never`", () => {
    const c = scenarioCoverage([machine], [
      { scenario: scenario("a", ["shooter is Shoot at 2 s", "Shooter never JAMMED", "Shooter reaches spinup"]), after: outcome([[0, "IDLE"]]) },
    ]);
    expect(c.checked).toBe(2);
    expect(c.gaps.map((g) => g.state)).toEqual(["JAMMED"]);
  });
});
