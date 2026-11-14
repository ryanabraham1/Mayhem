# How agents work tasks

This is the agent's side of the [Tasks](/suite/tasks) board: what it reads, what it writes, and when it waits for a person. Agents connected with the prompt from **Connect an agent** follow it automatically. It's documented here so you know what to expect, and so you can check an agent is doing it right.

## Where tasks live

Each task is one JSON file in the robot repo: `tools/mayhem/review/<id>.json`. Feedback from anywhere in the app lands there with its context, so the agent knows exactly what you meant:

- a **log moment**: the recording, seconds into it, the code revision, the field pose;
- an **auto step**: the routine and step;
- a **state machine**: the machine, state or transition;
- anything else right-clicked: the page, panel and item.

Commit task files with the code (or at least push them) so teammates and agents on other computers see them.

## The loop

| Step | Agent does | Board column |
| --- | --- | --- |
| 1 | `list_tasks`, then `get_task` for the context. Opens the linked log with the log tools. | New |
| 2 | `claim_task`. Mayhem records the current commit as the task's base. | Agent planning |
| 3 | `propose_plan` in plain English: what will change on the robot and how you'll see it. **Then waits.** No code changes before approval. | Plan to approve |
| 4 | After you approve: changes the code, runs the sim proof, commits with a `Mayhem-Task: <id>` line, and calls `report_progress`. | Agent working |
| 5 | `finish_task`, saying what it ran. | Ready to check |

If you send a plan or a change back, your note goes into the task and it returns to the agent. Your note is what it reads to try again, which is why sending back needs one.

## Code, simulate, read, fix

For a behavior bug, agents are expected to close the loop before asking you:

1. Change the code, and regenerate `MayhemProject.h` with `tools/mayhem/export.sh` if the project or `machines.json` changed.
2. Run the relevant [sim proof scenarios](/robot-code/scenarios) on the uncommitted code (`run_scenarios`).
3. Read the result's log: `log_states` for a state machine problem; `log_anomalies`, `log_what_changed` and `log_table` for anything else.
4. Fix and repeat. Before handing off, run everything against the base and add a scenario that reproduces the bug, so it stays fixed.

## What gets accepted without you

Mayhem rates every reported commit with the same review the [Changes](/suite/changes) page shows:

| Risk | Means | Accepted automatically? |
| --- | --- | --- |
| **Red** | CAN IDs, current limits, brake/coast, motor directions, gear ratios, offsets; or generated code out of date | No |
| **Yellow** | Driver controls, state machines, other values, any other robot code, a loosened scenario | No |
| **Green** | Only auto paths changed, and every changed path still finishes | Yes |
| **None** | Nothing that reaches the robot changed (notes, a new scenario) | Yes |

Most real fixes touch C++ logic that Mayhem can't read, so they're yellow and wait for a person. Judge those by the sim proof.

## Stalled agents

A task an agent has held for a day without an update shows **no update for …**. Use **Back to New** to take it back; another agent (or the same one, restarted) can pick it up.
