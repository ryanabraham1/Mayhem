import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../../scripts/mayhem.mjs";
import { desktop, fixtureRepo } from "./reviewBridge";

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
