import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
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

/** The desktop bridge, faked with the same git reader the CLI uses and real file writes. */
/** A fake roboRIO for "On the robot now": its build stamp, and deploys recorded instead of run. */
export const fakeRobot = { stamp: "" as string, deploys: [] as { rev: string; team: number }[] };

export async function desktop(page: Page, repo: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  await page.exposeFunction("__mayhemInvoke", async (cmd: string, args: Record<string, any>) => {
    if (cmd === "plugin:dialog|open") return repo;
    // ask/confirm: the clicked button's label (here always the OK one).
    if (cmd === "plugin:dialog|message") return args.buttons?.OkCancelCustom?.[0] ?? args.buttons?.OkCustom ?? "Yes";
    if (cmd === "robot_build_info") {
      if (!fakeRobot.stamp) throw new Error("Robot SFTP failed: no route to host");
      return fakeRobot.stamp;
    }
    if (cmd === "robot_deploy") {
      fakeRobot.deploys.push({ rev: args.rev, team: args.team });
      fakeRobot.stamp = JSON.stringify({ sha: git("rev-parse", args.rev), branch: "rollback", dirty: [], builtAt: new Date().toISOString(), builtBy: "mayhem" });
      return "BUILD SUCCESSFUL\nDeployed to roborio-3256-frc.local";
    }
    if (cmd === "review_repo")
      return {
        root: repo,
        branch: git("rev-parse", "--abbrev-ref", "HEAD"),
        head: git("rev-parse", "HEAD"),
        dirty: git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3)),
        revisions: [
          ...git("for-each-ref", "--format=%(refname:short)\t%(objectname)\t%(subject)", "refs/heads").split("\n").filter(Boolean).map((l) => {
            const [rev, sha, label] = l.split("\t");
            return { rev, sha, label, kind: "branch", date: "" };
          }),
          ...git("log", "-30", "--format=%H\t%s").split("\n").map((l) => {
            const [sha, subject] = l.split("\t");
            return { rev: sha, sha, label: subject, kind: "commit", date: "" };
          }),
        ],
      };
    if (cmd === "review_snapshot") return gitSnapshot(repo, args.rev);
    if (cmd === "review_items") {
      const dir = join(repo, "tools/mayhem/review");
      try {
        return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => ({ id: n.slice(0, -5), text: readFileSync(join(dir, n), "utf8") }));
      } catch {
        return [];
      }
    }
    if (cmd === "review_item_save") {
      const path = join(repo, "tools/mayhem/review", `${args.id}.json`);
      let current: string | null = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {}
      if (current !== (args.expected ?? null)) throw new Error("changed meanwhile");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.text);
      return null;
    }
    if (cmd === "review_history") {
      if (!args.paths.length) return [];
      return git("log", `-${args.limit ?? 8}`, "--format=%H%x1f%s%x1f%an %cr%x1e", "--", ...args.paths).split("\x1e").filter((e) => e.trim()).map((e) => {
        const [sha, subject, body] = e.trim().split("\x1f");
        return { sha, subject, body: body ?? "" };
      });
    }
    if (cmd === "review_commits") {
      const range = `${args.before === "WORKTREE" ? "HEAD" : args.before}..${args.after === "WORKTREE" ? "HEAD" : args.after}`;
      return git("log", "--format=%H%x1f%s%x1f%b%x1e", range).split("\x1e").filter((e) => e.trim()).map((e) => {
        const [sha, subject, body] = e.trim().split("\x1f");
        return { sha, subject, body: body ?? "" };
      });
    }
    // Sim proof through the CLI's runner (the real robot build; only with MAYHEM_REVIEW_REPO).
    if (cmd === "review_sim_prepare") return (await nodeRunner(repo)).prepare(args.rev);
    if (cmd === "review_sim_run") return (await nodeRunner(repo)).run(args.dir, args.id, args.scenario);
    if (cmd === "read_log_file") return readFileSync(args.path).toString("base64");
    if (cmd === "review_write_file") {
      const path = join(repo, args.path);
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {}
      if (current !== args.expected) throw new Error("changed on disk");
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

