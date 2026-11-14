# The app at a glance

Mayhem opens to **Overview**. The top bar switches between the workspaces; the robot chip shows the connection, and the gear opens [Settings](/suite/projects#settings). The **Tasks** tab shows a count when plans or changes are waiting for you.

| Workspace | What it's for |
| --- | --- |
| [Overview](#overview) | Routine thumbnails, latest logs, the match-ready checklist and the robot explainer. |
| [Changes](/suite/changes) | What a robot code change does: driver controls, state machines, values, hardware, autos, and a sim proof. |
| [Tasks](/suite/tasks) | Team feedback that becomes agent tasks; approve plans and check changes. |
| [Autonomous](/suite/autonomous) | Place pose goals on the field, add actions and conditions, preview the routine. |
| [State machines](/suite/state-machines) | Routine and mechanism graphs, simulated, live over NT4 or replayed from a log. |
| [Logs](/suite/logs) | Import and analyze `.wpilog` recordings: health, power, signals and pose replay. |
| [Robot](/suite/robot) | What's on the robot now, every value in the code, specs and limits, connection and log collection. |

Most workspaces that read robot code (Changes, Tasks, Robot → On the robot now and Values, the explainer) need the **desktop app** and a **robot code folder**. Choose the folder once from any of them; the rest use the same one. If the folder has a `robot.mayhem.json`, choosing it also opens that project, linked to the file, so Autonomous and State machines show this robot.

## Overview

![Overview](/img/suite/overview.jpg)


- **Autonomous routines.** A thumbnail per routine with its run time, marked **Ready** or **Doesn't finish**. Click one to open it in Autonomous.
- **Feedback and agents.** How many plans and changes are waiting for you, how many tasks agents hold, and how many are new, with the waiting ones listed. Click one to open it in Tasks. The last line says when each agent was last active.
- **Latest logs.** The newest recordings and whether their analysis is clean.
- **Get to match-ready.** Checks, each with a button that takes you to the fix:
  1. The robot code folder is chosen (desktop app).
  2. An agent has picked up a task (desktop app).
  3. A routine runs without errors.
  4. The robot is connected.
  5. Log collection is on.
  6. The exported C++ matches the current project.

  Project errors and warnings are listed under the checklist.
- **How the robot works.** A clickable map of the robot read from its code. Click a part to see what it does, how the driver controls it, what it's doing right now (when connected) and its recent commits. Anyone can write or edit a part's plain-language description.

## Right-click anything

Right-click a step, a state, a log moment, a finding or most other things to get **Make this an agent task**. The new task is pinned to what you clicked, so an agent knows exactly what you meant. See [Tasks](/suite/tasks).

## Desktop vs. browser

| | Desktop app | Browser (`pnpm dev`) |
| --- | --- | --- |
| Autos, preview, state simulation, log analysis | Yes | Yes |
| Live file link to a project in the robot repo | Yes | Download snapshots only |
| Changes, Tasks, Values, On the robot now | Yes | Changes opens saved review files; feedback downloads as files |
| Log collection, AdvantageScope, deploy | Yes | No |

Install the desktop app from [Installation](/guide/installation).
