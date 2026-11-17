import { describe, expect, it } from "vitest";
import { defaultParallel, runSimProof, type SimRunner } from "../src/suite/core/review/simproof";
import type { Scenario } from "../src/suite/core/review/scenarios";

const scenario = (n: number): Scenario => ({ id: `s${n}`, name: `S${n}`, group: "custom", alliance: "blue", field: true, steps: ["teleop", "wait 1"], expect: [] });
const recording = { name: "x", duration: 1, channels: [], warnings: [] };

describe("runSimProof", () => {
  it("runs the before version while the after version builds", async () => {
    const events: string[] = [];
    let finishAfterBuild!: () => void;
    const runner: SimRunner = {
      async prepare(rev) {
        events.push(`build ${rev}`);
        if (rev === "after") await new Promise<void>((done) => (finishAfterBuild = done));
        events.push(`built ${rev}`);
        return { dir: rev, cached: false };
      },
      async run(dir, id) {
        events.push(`run ${dir} ${id}`);
        // The last before run lets the after build finish: runs went on while it built.
        if (dir === "before" && id === "s2") setTimeout(() => finishAfterBuild(), 0);
        return { log: `${dir}/${id}.wpilog`, ok: true, output: "" };
      },
      readLog: async () => recording,
    };
    const proof = await runSimProof(runner, { before: "before", after: "after" }, [1, 2].map(scenario), [], () => {}, 2);
    expect(proof.results.every((r) => r.logs.before && r.logs.after)).toBe(true);
    expect(events.indexOf("run before s1")).toBeLessThan(events.indexOf("built after"));
    expect(events.indexOf("built after")).toBeLessThan(events.indexOf("run after s1"));
  });

  it("stops with the build error when a version does not build", async () => {
    const runner: SimRunner = {
      prepare: async (rev) => {
        if (rev === "after") throw new Error("The robot code did not build");
        return { dir: rev, cached: false };
      },
      run: async (dir, id) => ({ log: `${dir}/${id}.wpilog`, ok: true, output: "" }),
      readLog: async () => recording,
    };
    await expect(runSimProof(runner, { before: "before", after: "after" }, [1, 2, 3].map(scenario), [], () => {}, 2)).rejects.toThrow("did not build");
  });

  it("runs twice as many processes as cores", () => {
    expect(defaultParallel(10)).toBe(20);
    expect(defaultParallel(1)).toBe(2);
    expect(defaultParallel(64)).toBe(32);
  });
});
