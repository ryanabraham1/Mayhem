# Introduction

Mayhem is a robot software workspace for pose-based autonomous routines, state-machine inspection, and log playback and analysis. The development suite combines these tools in one app, with shared robot connection and background log collection.

## Choose your workflow

| Workflow | Start here |
| --- | --- |
| New suite: pose goals, inputs, callbacks, C++ integration | [Your first suite routine](/guide/quick-start) and [suite workflows](/guide/suite) |
| Existing solver projects and Java MayhemLib | [Your first classic trajectory](/guide/classic-quick-start) |
| Build the development app | [Building and contributing](/reference/building) |

## The suite workspaces

- **Overview:** routine thumbnails, recent logs, connection status and project checks.
- **Autonomous:** edit pose/translation goals, moving handoffs and robot actions; preview the path or full routine with simulated inputs.
- **State machines:** inspect routine and mechanism graphs in simulation, live over read-only NT4, or from recorded signals.
- **Logs:** import WPILOG files, investigate findings, inspect power and signals, and replay poses.
- **Robot:** connection, automatic robot/folder collection, team upload, robot limits and typed inputs.
- **Agents:** project brief, live file link, CLI/MCP setup, C++ export and JSON.
- **Settings:** appearance, recovery snapshots and the classic trajectory planner.

The suite is in development. Preview does not execute custom robot code or establish physical obstacle avoidance. Physical robot validation and cross-platform release checks remain outstanding. See the [implementation status](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SUITE_STATUS.md) for verification boundaries.

## Classic trajectory planner

Open **Settings → Classic trajectory planner → Open classic planner** for existing paths. The Python CasADi/IPOPT solver generates time-optimal trajectories with drivetrain limits and swept bumper collision checks. Java MayhemLib follows exported `.mtraj` files with feedback and bump recovery. These files and APIs are separate from suite JSON projects and the C++ pose controller.

The pages under **Classic planner** and **MayhemLib** document that workflow; their screenshots show the classic UI.
