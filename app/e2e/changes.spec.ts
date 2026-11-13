import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitSnapshot } from "../../scripts/review-git.mjs";
import { nodeRunner } from "../../scripts/review-sim.mjs";

const SHOOTER = `#pragma once
namespace shooter {
/** CAN IDs; shooters[0] is the leader, the rest follow it. */
inline constexpr std::array<int, 2> kMotorIds = {
    44,  // left
    45,  // right
};
inline ctre::phoenix6::configs::TalonFXConfiguration MotorConfigs() {
  return configs::TalonFXConfiguration{}
      .WithMotorOutput(configs::MotorOutputConfigs{}.WithNeutralMode(signals::NeutralModeValue::Coast))
      .WithCurrentLimits(configs::CurrentLimitsConfigs{}.WithStatorCurrentLimit(80_A));
}
}  // namespace shooter
`;
const SLIDE = `#pragma once
namespace linear_slide {
inline constexpr int kRightMotorID = 39;
inline ctre::phoenix6::configs::TalonFXConfiguration RightMotorConfigs() {
  return configs::TalonFXConfiguration{}.WithCurrentLimits(configs::CurrentLimitsConfigs{}.WithStatorCurrentLimit(15_A));
}
}  // namespace linear_slide
`;
const MACHINES = (when: string) =>
  JSON.stringify({
    machines: [
      {
        id: "Shooter",
        inputs: { operator: { shootHeld: "A held (shoot)" }, internal: { enabled: "Robot enabled" } },
        states: { OFF: "Off", SHOOTING: "Shooting" },
        transitions: ["* -> OFF: !enabled", `OFF -> SHOOTING: ${when}`, "SHOOTING -> OFF: !shootHeld"],
      },
    ],
  });

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "mayhem-changes-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("src/main/include/subsystems/shooter/ShooterConstants.h", SHOOTER);
  write("src/main/include/subsystems/linearslide/LinearSlideConstants.h", SLIDE);
  write("tools/mayhem/machines.json", MACHINES("shootHeld && enabled"));
  git("add", ".");
  git("commit", "-qm", "Robot code");
  // An agent's change: lower current limit, A shoots even while disabled.
  write("src/main/include/subsystems/shooter/ShooterConstants.h", SHOOTER.replace("80_A", "60_A"));
  write("tools/mayhem/machines.json", MACHINES("shootHeld"));
  git("commit", "-qam", "Agent: shooter tuning");
  return repo;
}

/** The desktop bridge, faked with the same git reader the CLI uses and real file writes. */
async function desktop(page: Page, repo: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  await page.exposeFunction("__mayhemInvoke", async (cmd: string, args: Record<string, any>) => {
    if (cmd === "plugin:dialog|open") return repo;
    if (cmd === "review_repo")
      return {
        root: repo,
        branch: git("rev-parse", "--abbrev-ref", "HEAD"),
        head: git("rev-parse", "HEAD"),
        dirty: git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3)),
        revisions: git("log", "-30", "--format=%H\t%s").split("\n").map((l) => {
          const [sha, subject] = l.split("\t");
          return { rev: sha, sha, label: subject, kind: "commit", date: "" };
        }),
      };
    if (cmd === "review_snapshot") return gitSnapshot(repo, args.rev);
    // Sim proof through the CLI's runner (the real robot build; only with MAYHEM_REVIEW_REPO).
    if (cmd === "review_sim_prepare") return (await nodeRunner(repo)).prepare(args.rev);
    if (cmd === "review_sim_run") return (await nodeRunner(repo)).run(args.dir, args.id, args.scenario);
    if (cmd === "read_log_file") return readFileSync(args.path).toString("base64");
    if (cmd === "review_write_file") {
      const path = join(repo, args.path);
      if (readFileSync(path, "utf8") !== args.expected) throw new Error("changed on disk");
      writeFileSync(path, args.text);
      return null;
    }
    return null;
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        if (cmd.startsWith("plugin:event|")) return 1;
        const result = await (window as any).__mayhemInvoke(cmd, args);
        // Log bytes cross the fake bridge as base64.
        return cmd === "read_log_file" ? Uint8Array.from(atob(result), (c) => c.charCodeAt(0)).buffer : result;
      },
      transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
  });
}

const tab = (page: Page, name: RegExp) => page.getByRole("group", { name: "Review sections" }).getByRole("button", { name }).click();
const shots = process.env.MAYHEM_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
};

test("reviews an agent's change and edits a CAN ID into the robot code", async ({ page }) => {
  const repo = process.env.MAYHEM_REVIEW_REPO ?? fixtureRepo();
  await desktop(page, repo);
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "Choose robot code folder" }).first().click();
  // The agent's commit against the one before it.
  const sha = (rev: string) => execFileSync("git", ["-C", repo, "rev-parse", rev]).toString().trim();
  await page.getByLabel("Before version").selectOption(sha(process.env.MAYHEM_REVIEW_BEFORE ?? "HEAD~1"));
  await page.getByLabel("After version").selectOption(sha("HEAD"));
  await expect(page.getByRole("status").filter({ hasText: "Safety change" })).toBeVisible();
  await shot(page, "1-summary");

  await tab(page, /^Controls/);
  await expect(page.getByRole("alert").filter({ hasText: "Driver controls changed" })).toBeVisible();
  await shot(page, "2-controls");

  await tab(page, /^State machines/);
  await expect(page.locator(".mx-edge.is-diff-changed").first()).toBeVisible();
  await shot(page, "3-machines");

  await tab(page, /^Values/);
  await shot(page, "4-values");

  if (process.env.MAYHEM_REVIEW_REPO) {
    await tab(page, /^Autos/);
    await shot(page, "5-autos");
  }

  if (process.env.MAYHEM_REVIEW_REPO) {
    test.setTimeout(900_000);
    await tab(page, /^Sim proof/);
    await page.getByRole("button", { name: "Run sim proof" }).click();
    await expect(page.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 800_000 });
    await page.getByRole("button", { name: /^Outpost Trench Sweep x2/ }).click();
    await page.getByLabel("Replay time").fill("16");
    await shot(page, "9-sim-autos");
    await page.getByRole("button", { name: /^Outpost Trench Sweep\b(?! x2)/ }).click();
    await shot(page, "10-sim-not-regenerated");
    await page.getByRole("button", { name: /^Buttons/ }).click();
    await shot(page, "11-sim-buttons");
  }

  // Edit: the working copy against the last commit; give the shooter's second motor a new CAN ID.
  await page.getByLabel("Before version").selectOption("HEAD");
  await page.getByLabel("After version").selectOption("WORKTREE");
  await tab(page, /^Hardware/);
  await page.getByRole("button", { name: /^Shooter/ }).first().click();
  await shot(page, "6-hardware");
  await page.getByRole("button", { name: "Edit Motor 2 (bottom left) CAN ID" }).or(page.getByRole("button", { name: "Edit Motor 2 (right) CAN ID" })).click();
  const dialog = page.getByRole("dialog", { name: "Edit value" });
  await dialog.getByLabel("New value").fill("39");
  await expect(dialog.getByRole("alert").filter({ hasText: "CAN ID 39 would be used by" })).toBeVisible();
  await shot(page, "7-edit-conflict");
  await dialog.getByLabel("New value").fill("46");
  await expect(dialog.getByText(/^Safety setting/)).toBeVisible();
  await dialog.getByRole("button", { name: "Save to robot code" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".mx-hw-ids i.is-changed", { hasText: "46" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Safety change" })).toBeVisible();
  await shot(page, "8-after-edit");
  const file = readFileSync(join(repo, "src/main/include/subsystems/shooter/ShooterConstants.h"), "utf8");
  expect(file).toMatch(/46,\s+\/\/ (right|bottom left)/);
});
