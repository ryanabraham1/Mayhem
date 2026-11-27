import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { bridgeState, createBridge, installBridge } from "../../scripts/desktop-bridge.mjs";

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

export function fixtureRepo() {
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

/** A fake roboRIO for "On the robot now": its build stamp, and deploys recorded instead of run. */
export const fakeRobot = { stamp: "" as string, deploys: [] as { rev: string; team: number }[], logs: "" };
/** Paths the next open-file dialogs return, in order; otherwise the dialog picks the repo. */
export const dialogPicks: string[] = [];

/** The desktop app's native commands on this page: scripts/desktop-bridge.mjs (real files and git, fake robot and website). */
export async function desktop(page: Page, repo: string) {
  const state = bridgeState(repo);
  state.robot = fakeRobot;
  state.picks = dialogPicks;
  await installBridge(page, createBridge(state));
  return state;
}


/** Picks a version in the Changes page's before/after picker (a sha, branch, HEAD or WORKTREE). */
export async function pickVersion(page: Page, side: "Before" | "After", rev: string) {
  await page.getByRole("button", { name: `${side} version` }).click();
  await page.getByLabel(`Search ${side.toLowerCase()} versions`).fill(rev === "WORKTREE" || rev === "HEAD" ? "" : rev);
  await page.locator(`[role="option"][data-value="${rev}"]`).first().click();
}
