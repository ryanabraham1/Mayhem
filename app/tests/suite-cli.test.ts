// @vitest-environment node
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
