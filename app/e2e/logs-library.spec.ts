import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoLog } from "../../scripts/make-demo-log.mjs";
import { desktop } from "./reviewBridge";

test.use({ storageState: { cookies: [], origins: [] } });

test("pulls a log off the robot into the library, finds its problems, shares it with the team and reveals it", async ({ page }, info) => {
  page.on("pageerror", (error) => { throw error; });
  const repo = mkdtempSync(join(tmpdir(), "mayhem-logs-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const robotLogs = join(repo, "robot-logs");
  mkdirSync(robotLogs);
  writeFileSync(join(robotLogs, "match_q12.wpilog"), demoLog());
  const bridge = await desktop(page, repo);
  bridge.robot = { ...bridge.robot, logs: robotLogs };
  await page.goto("/");

  // Robot → Log collection: list what's on the robot, pick one, download it.
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("button", { name: "Set up robot collection" }).click();
  await page.getByRole("button", { name: "List robot logs" }).click();
  await page.getByRole("checkbox", { name: /match_q12\.wpilog/ }).check();
  await page.getByRole("button", { name: "Download selected (1)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 downloaded" })).toBeVisible();

  // It is in the library, analyzed: the demo log's brownout is flagged.
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  const library = page.getByRole("complementary", { name: "Recordings" });
  await expect(library.getByText("match_q12")).toBeVisible();
  await expect(page.getByText("Robot reported a brownout")).toBeVisible();

  // Share with the team: needs a device token, then it shows in the team cloud.
  await page.getByRole("button", { name: "Add token" }).click();
  await page.getByLabel("Device upload token").fill("mhm_test");
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("button", { name: "Upload match_q12.wpilog to team cloud" }).click();
  await expect.poll(() => bridge.team.map((l: { name: string }) => l.name)).toEqual(["match_q12.wpilog"]);
  await page.getByRole("button", { name: "Refresh team cloud" }).click();
  await expect(page.getByRole("region", { name: "Team cloud" }).getByText("this computer")).toBeVisible();

  await expect(page.getByRole("button", { name: "Upload match_q12.wpilog to team cloud" })).toBeDisabled();

  // Show in Finder and AdvantageScope open the library copy (recorded, not opened).
  await page.getByRole("button", { name: "Show in Finder (match_q12.wpilog)" }).click();
  await page.getByRole("button", { name: "Open match_q12.wpilog in AdvantageScope" }).click();
  await expect.poll(() => bridge.opened.map((o: { kind: string }) => o.kind)).toEqual(["reveal", "viewer"]);
  await page.screenshot({ path: info.outputPath("library.png") });
});
