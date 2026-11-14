# How changes get reviewed

You tell your agent what you want in its chat. You review what it did in Mayhem. There is no task queue to keep in sync with the conversation: the unit of review is a **branch**.

## What the agent does

| Step | Agent does | In the app |
| --- | --- | --- |
| 1 | Works on a branch (never `main`) and commits. Asks you in the chat when what you want is unclear. | The branch appears under **Changes → To review**. |
| 2 | `behavior_diff` with `base: "main"`: what you'll be shown. Anything in it that it didn't mean to change, it fixes. | The branch's risk chip. |
| 3 | `run_scenarios` with `base: "main"`, `after: "HEAD"`: every button, every auto and every team scenario, on the commit. | **sim proof passed**, **differs** or **failed** on the branch. |
| 4 | Tells you it's ready. | You review it in [Changes](/suite/changes). |

The prompt under **Settings → Agents and the project file → Tell your agent once** says exactly this. Paste it into the chat, or into the robot repo's `CLAUDE.md` or `AGENTS.md` so every session starts with it. Agents using the Mayhem MCP server are told the same when they connect.

## Code, simulate, read, fix

For a behavior bug, agents are expected to close the loop before asking you:

1. Change the code, and regenerate `MayhemProject.h` with `tools/mayhem/export.sh` if the project or `machines.json` changed.
2. Run the relevant [sim proof scenarios](/robot-code/scenarios) on the uncommitted code (`run_scenarios`).
3. Read the result's log: `log_states` for a state machine problem; `log_anomalies`, `log_what_changed` and `log_table` for anything else.
4. Fix and repeat. Before handing off, add a scenario that reproduces the bug, so it stays fixed, then commit and run everything on the commit (step 3 above).

## The sim proof is recorded, not described

When `run_scenarios` runs on a commit, the tool writes the result onto that commit as a git note: how many scenarios ran, which failed, which behave differently, what it was compared with, who ran it and when. That record is what you see on the branch. An agent can't type it in, a run on uncommitted files isn't recorded, and a newer commit has none until a proof is run on it. If the agent didn't run one, the branch says **no sim proof**, and **Run sim proof** runs it and keeps the result.

Notes stay on the computer they were made on unless pushed (`git push origin refs/notes/mayhem-proof`). That's fine when the agent runs in your terminal, which is the usual setup.

## How risky a change is

Mayhem rates every branch with the same review the [Changes](/suite/changes) page shows:

| Risk | Means |
| --- | --- |
| **Red** | CAN IDs, current limits, brake/coast, motor directions, gear ratios, offsets; or generated code out of date |
| **Yellow** | Driver controls, state machines, other values, any other robot code, a removed or loosened scenario |
| **Green** | Only auto paths changed, and every changed path still finishes |
| **None** | Nothing that reaches the robot changed (notes, a new scenario) |

Most real fixes touch C++ logic that Mayhem can't read, so they're yellow. Judge those by the sim proof.

## After you merge

Merge the branch yourself (agents don't push to `main`). It moves to **Merged**, and Mayhem follows it without anyone reporting anything: **in main** however it got there (merge, rebase or squash), **on the robot** once the code read off the robot includes it, **in a log** once a collected log says it ran that code. Agents never deploy.
