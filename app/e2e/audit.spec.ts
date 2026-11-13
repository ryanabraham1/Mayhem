// Visual audit of the review suite (not part of the regular run): MAYHEM_AUDIT=<folder> writes a
// screenshot of every screen in light and dark, at a laptop and a narrow width, plus a list of
// elements that overflow their box. Uses MAYHEM_REVIEW_REPO (a robot repo with sim runs cached).
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../../scripts/mayhem.mjs";
import { desktop, fakeRobot } from "./reviewBridge";

const out = process.env.MAYHEM_AUDIT;
const repo = process.env.MAYHEM_REVIEW_REPO;
test.skip(!out || !repo, "visual audit only");

async function overflow(page: Page) {
  return page.evaluate(() => {
    const issues: string[] = [];
    const main = document.querySelector(".mx-main");
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".mx-main *"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).position === "absolute" || el.closest(".mx-table-scroll, .mx-board, .mx-graph-scroll, svg, .mx-timeline, .mx-lane-bar, dialog:not([open])")) continue;
      const parent = el.parentElement!;
      const p = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (style.overflowX !== "visible") continue;
      if (r.right > p.right + 2 && r.width > 8 && main?.contains(parent))
        issues.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} overflows ${parent.tagName.toLowerCase()}.${(parent.className || "").toString().split(" ")[0]} by ${Math.round(r.right - p.right)}px: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return [...new Set(issues)].slice(0, 15);
  });
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 1024])
    test(`audit ${theme} ${width}`, async ({ page }) => {
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args]).toString().trim();
      fakeRobot.stamp = JSON.stringify({ sha: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: ["src/main/include/subsystems/shooter/ShooterConstants.h"], builtAt: "2026-11-13T10:00:00-08:00", builtBy: "maya", computer: "pit-laptop" });
      await desktop(page, repo!);
      await page.addInitScript((t) => localStorage.setItem("mayhem.theme", t), theme);
      await page.goto("/");
      const shots: string[] = [];
      const shot = async (name: string) => {
        await page.waitForTimeout(150);
        const file = `${theme}-${width}-${name}.png`;
        await page.screenshot({ path: join(out!, file), fullPage: true });
        const issues = await overflow(page);
        appendFileSync(join(out!, "issues.txt"), `${file}: ${issues.length ? "\n  " + issues.join("\n  ") : "ok"}\n`);
        shots.push(file);
      };
      const tab = (name: RegExp) => page.getByRole("group", { name: "Review sections" }).getByRole("button", { name }).click();
      await page.getByRole("button", { name: "Changes", exact: true }).click();
      await page.getByRole("button", { name: /Choose robot code folder|robot-demo/ }).first().click();
      await page.getByLabel("Before version").selectOption(git("rev-parse", "mayhem/suite-integration"));
      await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
      await expect(page.locator(".mx-risk")).toBeVisible();
      await shot("changes-summary");
      for (const [name, re] of [["controls", /^Controls/], ["machines", /^State machines/], ["values", /^Values/], ["hardware", /^Hardware/], ["autos", /^Autos/]] as const) {
        await tab(re);
        await shot(`changes-${name}`);
      }
      await tab(/^Values/);
      await page.getByRole("button", { name: "All values" }).click();
      await shot("changes-values-all");
      await page.getByLabel("After version").selectOption("WORKTREE");
      await tab(/^Hardware/);
      await page.getByRole("button", { name: /^Shooter\b/ }).first().click();
      await page.locator(".mx-cell-edit").first().click();
      await shot("changes-edit");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByLabel("After version").selectOption(git("rev-parse", "HEAD"));
      await tab(/^Sim proof/);
      await page.getByRole("button", { name: "Run sim proof" }).click();
      await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 500_000 });
      await shot("sim-autos");
      await page.getByRole("button", { name: /^Buttons/ }).click();
      await shot("sim-buttons");
      await page.getByRole("button", { name: /^Team scenarios/ }).click();
      await shot("sim-team");
      // Tasks with a few items in different states.
      const items = await execute("list_tasks", { repo, status: ["open", "claimed", "plan", "approved", "review", "done"] });
      if (!items.tasks.length) await execute("add_feedback", { repo, author: "Maya", kind: "pit-note", text: "Left intake roller rubbing the frame" });
      await page.getByRole("button", { name: /^Tasks/ }).click();
      await shot("tasks");
      await page.locator(".mx-task-card").first().click();
      await shot("tasks-detail");
      await page.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Driver form" }).click();
      await shot("tasks-driver-form");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Add feedback" }).click();
      await shot("tasks-feedback");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByText("Connect an agent").click();
      await shot("tasks-agents");
      await page.getByRole("button", { name: "Robot", exact: true }).click();
      await page.getByRole("button", { name: "On the robot now" }).click();
      await page.getByRole("button", { name: "Check robot" }).click();
      await shot("robot-now");
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.locator(".mx-explainer").scrollIntoViewIfNeeded();
      await shot("overview");
      await page.getByRole("button", { name: "Autonomous", exact: true }).click();
      await shot("autos");
      await page.getByRole("button", { name: "State machines", exact: true }).click();
      await shot("states");
      expect(shots.length).toBeGreaterThan(10);
    });
