# Introduction

Mayhem is one desktop app for a robot's software: build pose-based autos, inspect state machines, analyze match logs, see what's running on the robot, review what a code change actually does, and turn team feedback into tasks for coding agents.

## Choose your workflow

| You want to | Start here |
| --- | --- |
| Install the app | [Installation](/guide/installation) |
| Build an auto | [Your first routine](/guide/quick-start), then [Autonomous](/suite/autonomous) |
| Find your way around | [The app at a glance](/suite/overview) |
| Review a robot code change | [Changes](/suite/changes) |
| Hand work to agents | [Tasks](/suite/tasks) |
| Keep using solver `.mtraj` paths and Java MayhemLib | [Classic trajectory quick start](/guide/classic-quick-start) |
| Work on Mayhem itself | [Building and contributing](/reference/building) |

## The workspaces

- **[Overview](/suite/overview):** routine thumbnails, latest logs, the match-ready checklist and a clickable robot explainer.
- **[Changes](/suite/changes):** what a code change does to controls, state machines, values, hardware and autos, with a before/after sim proof.
- **[Tasks](/suite/tasks):** feedback, pit notes and driver forms become agent tasks; approve plans and check changes.
- **[Autonomous](/suite/autonomous):** place goals, add actions and conditions, preview the path or the full routine.
- **[State machines](/suite/state-machines):** graphs in simulation, live over NT4, or replayed from a log.
- **[Logs](/suite/logs):** findings, power, signals and pose replay for every recording.
- **[Robot](/suite/robot):** what's on the robot now, every value in the code, specs, connection and log collection.

Preview doesn't run your custom robot code or avoid obstacles, and the C++ pose controller still needs tuning on the real robot. See the [implementation status](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SUITE_STATUS.md) for what's been verified.

## Classic trajectory planner

Open **Settings → Classic trajectory planner → Open classic planner** for existing paths. The Python CasADi/IPOPT solver generates time-optimal trajectories with drivetrain limits and swept bumper collision checks, and Java MayhemLib follows the exported `.mtraj` files. These files and APIs are separate from suite projects and the C++ pose controller. The **Classic planner** and **MayhemLib** sections document that workflow.
