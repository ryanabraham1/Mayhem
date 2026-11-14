import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, recordTaskProof } from "../../scripts/mayhem.mjs";
import { demoLog } from "../../scripts/make-demo-log.mjs";
import { readItem, saveItem } from "../../scripts/review-tasks.mjs";
import { move } from "../src/suite/core/review/tasks";
import { desktop, dialogPicks, fakeRobot, fixtureRepo } from "./reviewBridge";

const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

test("feedback becomes an agent task: plan approval, commit, risk and the why link", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();

  // A pit note and a driver's comment.
  await page.getByLabel("Your name").fill("Maya");
  await page.getByLabel("Pit note").fill("Left intake roller is rubbing the frame");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "New" }).getByText("Left intake roller is rubbing the frame")).toBeVisible();
  await page.getByRole("button", { name: "Add feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Feedback" });
  await dialog.getByRole("button", { name: "Problem" }).click();
  await dialog.getByLabel("Short title").fill("Shooter keeps spinning after I let go of A");
  await dialog.getByLabel("What happened, or what should change?").fill("Happened in Qual 14 near the hub. Wastes battery.");
  await dialog.getByRole("button", { name: "Send to agents" }).click();
  await expect(page.getByRole("region", { name: "New" }).getByText("Shooter keeps spinning")).toBeVisible();

  // An agent picks it up and proposes a plan (the MCP tools, as an agent would).
  const { tasks } = await execute("list_tasks", { repo });
  const id = tasks.find((t: { title: string }) => t.title.startsWith("Shooter")).id;
  await execute("claim_task", { repo, id, agent: "claude-1" });
  await execute("propose_plan", { repo, id, agent: "claude-1", plan: "When A is released the shooter goes to Off instead of Rev, so it stops spinning. Check: hold A, let go: Shooter mode shows Off." });
  await expect(page.getByRole("region", { name: "Plan to approve" }).getByText("Shooter keeps spinning")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Tasks/ }).getByLabel("1 waiting for you")).toBeVisible();
  await shot(page, "t1-board");
  await page.getByRole("region", { name: "Plan to approve" }).getByText("Shooter keeps spinning").click();
  const detail = page.getByRole("dialog", { name: "Shooter keeps spinning after I let go of A" });
  await shot(page, "t2-plan");
  await detail.getByRole("button", { name: "Approve plan" }).click();
  await expect(detail.getByText("Approved by Maya")).toBeVisible();
  await detail.getByRole("button", { name: "Close" }).click();

  // The agent commits (with the task trailer), reports it and finishes.
  writeFileSync(join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h"), readShooter(repo).replace("60_A", "50_A"));
  git("commit", "-qam", `Shooter: lower limit\n\nMayhem-Task: ${id}`);
  await execute("report_progress", { repo, id, agent: "claude-1", revision: "HEAD", summary: "Lower the shooter limit" });
  await execute("finish_task", { repo, id, agent: "claude-1", note: "sim proof passes" });
  await expect(page.getByRole("region", { name: "Ready to check" }).getByText("Shooter keeps spinning")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("region", { name: "Ready to check" }).getByText("Shooter keeps spinning").click();
  await expect(detail.getByText("safety change")).toBeVisible();
  await shot(page, "t3-check");
  await detail.getByRole("button", { name: "See what changed on the robot" }).click();
  await expect(page.getByRole("region", { name: "Why this change" }).getByText("Shooter keeps spinning after I let go of A")).toBeVisible();
  await shot(page, "t4-why");
});

const readShooter = (repo: string) => execFileSync("cat", [join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h")]).toString();

test("a comment on an auto step reaches agents with the step's details", async ({ page }) => {
  const repo = fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  await page.getByRole("button", { name: "Comment on this step" }).click();
  const dialog = page.getByRole("dialog", { name: "Feedback" });
  await expect(dialog.getByText(/step “/)).toBeVisible();
  await dialog.getByLabel("What happened, or what should change?").fill("Approach this pickup slower, the intake bounces the piece away.");
  await dialog.getByLabel("Your name").fill("Maya");
  await shot(page, "t5-step-comment");
  await dialog.getByRole("button", { name: "Send to agents" }).click();
  const { tasks } = await execute("list_tasks", { repo });
  const task = await execute("get_task", { repo, id: tasks[0].id });
  expect(task.anchor).toMatchObject({ routine: expect.any(String), step: { id: expect.any(String), name: expect.any(String), kind: expect.any(String) } });
  expect(task.text).toMatch(/slower/);
});

test("right-click anything to make it an agent task", async ({ page }) => {
  const repo = fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByLabel("Your name").fill("Maya");
  const dialog = page.getByRole("dialog", { name: "Feedback" });
  const menuItem = page.getByRole("menuitem", { name: "Make this an agent task" });

  // An auto step: the task carries the routine and the step.
  await page.getByRole("button", { name: "Autonomous", exact: true }).click();
  const step = page.locator(".mx-step:not(.is-start)").first();
  await step.click({ button: "right" });
  await menuItem.click();
  await expect(dialog.getByText(/step “/)).toBeVisible();
  await dialog.getByLabel("What happened, or what should change?").fill("Slow down into this pickup.");
  await shot(page, "t6-right-click-step");
  await dialog.getByRole("button", { name: "Send to agents" }).click();
  await expect(dialog).toBeHidden();

  // Anything without a menu of its own: the page and what was clicked.
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("heading").first().click({ button: "right" });
  await menuItem.click();
  await expect(dialog.locator(".mx-anchor")).toContainText("Tasks");
  await dialog.getByLabel("What happened, or what should change?").fill("Show the oldest task first.");
  await dialog.getByRole("button", { name: "Send to agents" }).click();
  await expect(dialog).toBeHidden();

  const { tasks } = await execute("list_tasks", { repo });
  const all = await Promise.all(tasks.map((t: { id: string }) => execute("get_task", { repo, id: t.id })));
  expect(all.find((t) => /pickup/.test(t.text)).anchor).toMatchObject({ routine: expect.any(String), step: { id: expect.any(String) } });
  expect(all.find((t) => /oldest/.test(t.text)).anchor).toMatchObject({ page: "Tasks" });
});

test("the overview leads with what waits for you; unread code never skips review; sending back needs a reason", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  await desktop(page, repo);
  await page.goto("/");
  // First run: the overview asks for the robot code folder, then shows the queue.
  const work = page.locator(".mx-panel", { hasText: "Feedback and agents" });
  await work.getByRole("button", { name: "Choose robot code folder" }).click();
  await expect(work.getByRole("button", { name: /waiting for you/ })).toContainText("0");

  // An agent takes a task through to a change that only touches logic the review can't read.
  const added = await execute("add_feedback", { repo, author: "Maya", title: "Intake should retract when the slide stalls", text: "It keeps pushing against the wall." });
  await execute("claim_task", { repo, id: added.id, agent: "claude-1" });
  await execute("propose_plan", { repo, id: added.id, agent: "claude-1", plan: "Retract the intake when the slide current spikes for half a second." });
  await expect(work.getByRole("button", { name: /waiting for you/ })).toContainText("1", { timeout: 10_000 });
  await shot(page, "t7-overview");
  await work.getByRole("button", { name: /Intake should retract/ }).click();
  const detail = page.getByRole("dialog", { name: "Intake should retract when the slide stalls" });
  await expect(detail.getByText("Agent's plan")).toBeVisible();
  // Asking for another plan needs a note the agent can act on.
  await expect(detail.getByRole("button", { name: "Ask for a different plan" })).toBeDisabled();
  await detail.getByLabel("Note for the agent").fill("Only while intaking, not when stowed");
  await detail.getByRole("button", { name: "Ask for a different plan" }).click();
  await expect.poll(async () => (await execute("get_task", { repo, id: added.id })).planDecision).toMatchObject({ approved: false, note: "Only while intaking, not when stowed" });
  await execute("propose_plan", { repo, id: added.id, agent: "claude-1", plan: "Retract only while intaking." });
  await expect(detail.getByText("Retract only while intaking.")).toBeVisible({ timeout: 10_000 });
  await detail.getByRole("button", { name: "Approve plan" }).click();
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("status", { name: "Agents on this queue" })).toContainText("claude-1 has 1");

  mkdirSync(join(repo, "src/main/cpp/subsystems"), { recursive: true });
  writeFileSync(join(repo, "src/main/cpp/subsystems/Superstructure.cpp"), "void Superstructure::Periodic() { RetractOnStall(); }\n");
  git("add", ".");
  git("commit", "-qm", `Retract on stall\n\nMayhem-Task: ${added.id}`);
  await execute("report_progress", { repo, id: added.id, agent: "claude-1", revision: "HEAD", summary: "Retract on stall" });
  await execute("finish_task", { repo, id: added.id, agent: "claude-1" });
  // Not auto-accepted, and the change names the file instead of claiming nothing changed.
  const ready = page.getByRole("region", { name: "Ready to check" });
  await expect(ready.getByText("Intake should retract")).toBeVisible({ timeout: 10_000 });
  await ready.getByText("Intake should retract").click();
  await expect(detail.getByText(/Other robot code changed: Superstructure\.cpp/)).toBeVisible();
  await shot(page, "t8-unread-code");
  await expect(detail.getByRole("button", { name: "Not right, send back" })).toBeDisabled();
  await detail.getByRole("button", { name: "See what changed on the robot" }).click();
  await expect(page.locator(".mx-area-card", { hasText: "Other code" })).toContainText("1 file changed");
  await expect(page.locator(".mx-risk-chip")).toContainText("Behavior changes to review");
  await page.locator(".mx-area-card", { hasText: "Other code" }).click();
  await expect(page.getByRole("note", { name: "What only the sim proof can check" })).toContainText("Superstructure.cpp");
  await shot(page, "t9-sim-unread");
});

test("a change is checked against its recorded sim proof, then followed to main, the robot and a log", async ({ page }) => {
  const repo = fixtureRepo();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  fakeRobot.stamp = "";
  await desktop(page, repo);
  // No robot toolchain here: every simulated run hands back the same recorded log, so the proof
  // runs through the app's own judging and nothing is built.
  const simLog = join(mkdtempSync(join(tmpdir(), "mayhem-sim-")), "run.wpilog");
  writeFileSync(simLog, demoLog());
  await page.addInitScript((log) => {
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
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  await page.getByLabel("Your name").fill("Maya");

  // An agent takes a task to a committed change on its own branch, and finishes without a proof.
  const added = await execute("add_feedback", { repo, author: "Maya", title: "Intake should retract when the slide stalls", text: "It keeps pushing." });
  const id = added.id as string;
  await execute("claim_task", { repo, id, agent: "claude-1" });
  await execute("propose_plan", { repo, id, agent: "claude-1", plan: "Retract the intake when the slide stalls." });
  const planned = await readItem(repo, id);
  await saveItem(repo, move(planned.item, "approve", "Maya"), planned.text);
  git("checkout", "-q", "-b", `agent/${id}`);
  mkdirSync(join(repo, "src/main/cpp/subsystems"), { recursive: true });
  writeFileSync(join(repo, "src/main/cpp/subsystems/Superstructure.cpp"), "void Superstructure::Periodic() { RetractOnStall(); }\n");
  git("add", "src");
  git("commit", "-qm", `Retract on stall\n\nMayhem-Task: ${id}`);
  const reported = await execute("report_progress", { repo, id, agent: "claude-1", revision: "HEAD", summary: "Retract on stall" });
  const revision = reported.changes[0].revision as string;
  expect((await execute("finish_task", { repo, id, agent: "claude-1" })).warning).toMatch(/No sim proof/);

  // The person sees there is no proof, and one click starts it for exactly this change.
  const ready = page.getByRole("region", { name: "Ready to check" });
  await expect(ready.getByText("no sim proof")).toBeVisible({ timeout: 10_000 });
  await ready.getByText("Intake should retract").click();
  const detail = page.getByRole("dialog", { name: "Intake should retract when the slide stalls" });
  await expect(detail.getByText("Sim proof not run on this commit")).toBeVisible();
  await shot(page, "t10-no-proof");
  await detail.getByRole("button", { name: "Run sim proof" }).click();
  await expect(page.getByRole("group", { name: "Review sections" }).getByRole("button", { name: /^Sim proof/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("After version")).toHaveValue(revision);
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 30_000 });
  // The run is kept on the task's commit: back on the task, it is there, signed by who ran it.
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await expect(detail.getByText("Sim proof: 32 scenarios pass, same behavior")).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText(/run by Maya/)).toBeVisible();
  expect((await execute("get_task", { repo, id })).changes[0].proof).toMatchObject({ by: "Maya", before: reported.base, ran: 32, failed: [], different: [] });

  // An agent's run is recorded by the tool that ran the simulation, not typed into a note; the newest run shows.
  const ran = (name: string, failed: boolean, differences: string[] = []) => ({ scenario: { name }, failed, differences, checks: [], logs: {} });
  await recordTaskProof(repo, id, revision, { results: [ran("tap X", false), ran("hold LT", false, ["Intake mode: INTAKING → STOWED"]), ran("Depot Sweep", false)], passed: true, changed: 1 }, { by: "claude-1", before: reported.base });
  await expect(detail.getByText("Sim proof: 3 scenarios pass, 1 behaves differently")).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText(/run by claude-1/)).toBeVisible();
  await expect(detail.locator(".mx-proof li")).toHaveText(["hold LT"]);
  await shot(page, "t11-proof");
  await detail.getByRole("button", { name: "Accept the change" }).click();

  // Accepted is not the end. Nothing is merged yet.
  const lane = detail.getByRole("region", { name: "Where this change is now" });
  await expect(lane.locator("li")).toHaveText([/Accepted.*Maya/, /Not in main yet/, /Not on the robot.*has not been checked/, /No log with it yet/]);
  await shot(page, "t12-accepted");
  // A squash merge keeps the message, not the commit.
  git("checkout", "-q", "main");
  git("merge", "-q", "--squash", `agent/${id}`);
  git("commit", "-qm", `Retract on stall (#12)\n\nMayhem-Task: ${id}`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(lane.locator("li").nth(1)).toHaveText(/In main/);
  await expect(lane.locator("li").nth(1)).toHaveClass(/is-done/);

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
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const done = page.getByRole("region", { name: "Done" });
  await expect(done.getByText("in a log")).toBeVisible({ timeout: 10_000 });
  await done.getByText("Intake should retract").click();
  await expect(lane.locator("li")).toHaveText([/Accepted/, /In main/, /On the robot/, /In a log.*Q14/]);
  await expect(lane.locator("li.is-done")).toHaveCount(4);
  await shot(page, "t13-delivered");
});
