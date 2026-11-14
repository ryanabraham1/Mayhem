import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoLog } from "../../scripts/make-demo-log.mjs";
import "../../scripts/mayhem.mjs"; // installs the TypeScript import hook review-git.mjs needs
import { recordProof } from "../../scripts/review-git.mjs";
import { desktop, dialogPicks, fakeRobot, fixtureRepo } from "./reviewBridge";

const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

test("an agent's branch is reviewed by what it does, with its recorded sim proof, and followed to main, the robot and a log", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  fakeRobot.stamp = "";
  const start = git("rev-parse", "HEAD");
  // An agent's work: a branch off main that changes logic the review can't read.
  git("checkout", "-q", "-b", "agent/retract-on-stall");
  mkdirSync(join(repo, "src/main/cpp/subsystems"), { recursive: true });
  writeFileSync(join(repo, "src/main/cpp/subsystems/Superstructure.cpp"), "void Superstructure::Periodic() { RetractOnStall(); }\n");
  git("add", "src");
  git("-c", "user.name=claude", "commit", "-qm", "Retract the intake when the slide stalls");
  const tip = git("rev-parse", "HEAD");
  // And an older experiment nobody is waiting on.
  git("checkout", "-q", "-b", "experiment", start);
  writeFileSync(join(repo, "NOTES.md"), "try a wider intake\n");
  git("add", ".");
  git("commit", "-qm", "Notes for a wider intake");
  git("checkout", "-q", "main");

  await desktop(page, repo);
  // No robot toolchain here: every simulated run hands back the same recorded log, so the proof
  // runs through the app's own judging and nothing is built.
  const simLog = join(mkdtempSync(join(tmpdir(), "mayhem-sim-")), "run.wpilog");
  writeFileSync(simLog, demoLog());
  await page.addInitScript((log) => {
    localStorage.setItem("mayhem.review.author", "Maya");
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (cmd: string, args: unknown) =>
      cmd === "review_sim_prepare"
        ? Promise.resolve({ dir: "/sim", cached: true })
        : cmd === "review_sim_run"
          ? Promise.resolve({ log, result: null, ok: true, output: "" })
          : invoke(cmd, args);
  }, simLog);
  await page.goto("/");

  // The overview leads with what is waiting: the branch, how risky it is, and that nothing proved it.
  const waiting = page.locator(".mx-panel", { hasText: "Changes to review" });
  await waiting.getByRole("button", { name: "Choose robot code folder" }).click();
  const row = waiting.locator(".mx-branch", { hasText: "agent/retract-on-stall" });
  await expect(row).toContainText("Retract the intake when the slide stalls");
  await expect(row).toContainText("1 commit · claude");
  await expect(row.getByText("review", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText("no sim proof")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Suite tools" }).getByLabel("2 to review")).toBeVisible();
  await shot(page, "v1-overview");

  // Opening it compares the branch with where it left main.
  await row.getByRole("button").first().click();
  const branches = page.getByRole("complementary", { name: "Branches" });
  await expect(branches.getByRole("region", { name: "To review" }).locator(".mx-branch.is-active")).toContainText("agent/retract-on-stall");
  await expect(page.getByLabel("Before version")).toHaveValue(start);
  await expect(page.getByLabel("After version")).toHaveValue(tip);
  await expect(page.locator(".mx-risk-chip")).toContainText("Behavior changes to review");
  await expect(page.locator(".mx-area-card", { hasText: "Other code" })).toContainText("1 file changed");
  await expect(page.getByRole("region", { name: "Commits in this change" })).toContainText("Retract the intake when the slide stalls");
  const lane = page.getByRole("list", { name: "Where this change is now" });
  await expect(lane.locator("li")).toHaveText([/1 commit.*claude/, /Not in main yet/, /Not on the robot/, /No log with it yet/]);
  await expect(page.getByText("Sim proof not run on this commit")).toBeVisible();
  await shot(page, "v2-branch");

  // Running the proof here keeps its result on the commit, signed by who ran it.
  await page.getByRole("button", { name: "Run sim proof" }).first().click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Summary/ }).click();
  await expect(page.getByText("Sim proof: 32 scenarios pass, same behavior")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/run by Maya/)).toBeVisible();
  expect(JSON.parse(git("notes", "--ref=refs/notes/mayhem-proof", "show", tip)).proofs[0]).toMatchObject({ before: start, by: "Maya", ran: 32, failed: [] });
  await expect(branches.locator(".mx-branch", { hasText: "agent/retract-on-stall" }).getByText("sim proof passed")).toBeVisible();

  // An agent's run is recorded by the tool that ran the simulation; the newest run shows.
  await recordProof(repo, tip, { before: start, at: new Date().toISOString(), by: "claude", ran: 40, failed: [], different: ["hold LT"] });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Sim proof: 40 scenarios pass, 1 behaves differently")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".mx-proof li")).toHaveText(["hold LT"]);
  await shot(page, "v3-proof");

  // A branch nobody is waiting on can be set aside; a new commit would bring it back.
  await branches.getByRole("button", { name: "Set experiment aside" }).click();
  await expect(branches.getByRole("region", { name: "To review" }).locator(".mx-branch")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Suite tools" }).getByLabel("1 to review")).toBeVisible();
  await branches.getByText("Older or set aside").click();
  await expect(branches.locator("details .mx-branch")).toContainText("experiment");

  // Merged by squash: the commits are not in main, the change is.
  git("merge", "-q", "--squash", "agent/retract-on-stall");
  git("commit", "-qm", "Retract the intake when the slide stalls (#12)");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const merged = branches.getByRole("region", { name: "Merged" }).locator(".mx-branch", { hasText: "agent/retract-on-stall" });
  await expect(merged.getByText("in main")).toBeVisible({ timeout: 10_000 });
  await expect(lane.locator("li").nth(1)).toHaveText(/In main/);

  // Main goes on the robot; then a log recorded on that code comes back.
  const deployed = git("rev-parse", "HEAD");
  const stamp = { sha: deployed, branch: "main", dirty: [], builtAt: new Date().toISOString(), builtBy: "maya" };
  fakeRobot.stamp = JSON.stringify(stamp);
  await lane.getByRole("button", { name: "Check robot" }).click();
  await page.getByRole("button", { name: "Check robot" }).click();
  await expect(page.getByText(deployed.slice(0, 7))).toBeVisible();
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  const log = join(mkdtempSync(join(tmpdir(), "mayhem-log-")), "Q14.wpilog");
  writeFileSync(log, demoLog(stamp));
  dialogPicks.push(log);
  await page.getByRole("button", { name: "Import log" }).first().click();
  await expect(page.getByRole("button", { name: "Play log playback" })).toBeVisible();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(merged.getByText("in a log")).toBeVisible({ timeout: 10_000 });
  await expect(lane.locator("li")).toHaveText([/1 commit/, /In main/, /On the robot/, /In a log.*Q14/]);
  await expect(lane.locator("li.is-done")).toHaveCount(4);
  await shot(page, "v4-delivered");
});
