// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../scripts/mayhem.mjs";
import { sampleProject } from "../src/suite/core/sample";
const directory = await mkdtemp(join(tmpdir(), "mayhem-cli-"));
const path = join(directory, "robot.json");
await writeFile(path, JSON.stringify(sampleProject));
afterAll(() => rm(directory, { recursive: true, force: true }));
it("exposes complete path playback and deliberate full-routine callback results to agents", async () => {
  expect(await execute("simulate_auto", { path, mode: "path" })).toMatchObject({
    status: "completed",
    mode: "path",
  });
  expect(
    await execute("simulate_auto", {
      path,
      signals: { pieceDetected: true, shooterReady: true, shotComplete: true },
    }),
  ).toMatchObject({ status: "failed", mode: "routine" });
  expect(
    await execute("simulate_auto", {
      path,
      signals: { pieceDetected: true, shooterReady: true, shotComplete: true },
      actions: { "intake.acquire": "succeeded", "shooter.fire": "succeeded" },
    }),
  ).toMatchObject({ status: "completed", mode: "routine" });
  await expect(
    execute("simulate_auto", { path, mode: "skip-everything" }),
  ).rejects.toThrow(/mode/);
  await expect(
    execute("simulate_auto", { path, actions: { typo: "succeeded" } }),
  ).rejects.toThrow(/Invalid action/);
});
it("keeps agent writes revision checked and rejects stale saves without changing the file", async () => {
  const first = await execute("save_project", {
    path,
    project: sampleProject,
    expectedRevision: 0,
  });
  expect(first.revision).toBe(1);
  await expect(
    execute("save_project", {
      path,
      project: sampleProject,
      expectedRevision: 0,
    }),
  ).rejects.toThrow(/Revision conflict/);
  expect(await execute("inspect_project", { path })).toMatchObject({
    revision: 1,
  });
});
it("returns a compact analyze_log summary and supports channel/time queries", async () => {
  const log = join(directory, "recording.json");
  const samples = (v: (i: number) => number) =>
    Array.from({ length: 200 }, (_, i) => ({ time: i * 0.1, value: v(i) }));
  await writeFile(
    log,
    JSON.stringify({
      name: "t",
      duration: 20,
      warnings: [],
      channels: [
        { name: "/Robot/Battery", type: "double", samples: samples(() => 12) },
        {
          name: "/Arm/supplyCurrent",
          type: "double",
          samples: samples((i) => i),
        },
      ],
    }),
  );
  const summary: any = await execute("analyze_log", { path: log });
  expect(summary.channels).toBeUndefined();
  expect(summary.channelOverview.total).toBe(2);
  const q: any = await execute("analyze_log", {
    path: log,
    channels: ["arm"],
    from: 5,
    to: 10,
    maxSamples: 4,
  });
  expect(q.query.matched).toBe(1);
  expect(q.query.channels[0]).toMatchObject({ min: 50, max: 100 });
  expect(q.query.channels[0].series.length).toBeLessThanOrEqual(4);
  const full: any = await execute("analyze_log", { path: log, detail: "full" });
  expect(full.channels).toHaveLength(2);
});

it("starts the supported MCP entry with native Node, outside Vitest's resolver", () => {
  const script = fileURLToPath(
    new URL("../../scripts/mayhem.mjs", import.meta.url),
  );
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const output = execFileSync(process.execPath, [script, "mcp"], {
    encoding: "utf8",
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  });
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(responses[0].result.serverInfo.name).toBe("mayhem-suite");
  expect(
    responses[1].result.tools.some(
      (t: { name: string }) => t.name === "simulate_auto",
    ),
  ).toBe(true);
});
