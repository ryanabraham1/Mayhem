# Tasks

Feedback from the team becomes tasks for coding agents. You approve an agent's plan before it changes code, and check the change when it's done. Tasks live as one JSON file each in the robot repo's `tools/mayhem/review/` folder, so agents and teammates see them with the code. Choose the robot code folder first.

## Giving feedback

- **Add feedback**: thumbs up, thumbs down or a comment, with a short title and what should change.
- **Pit note**: the one-line box at the top. Type and press Save.
- **Driver form**: a quick post-match form (ratings, yes/no questions, what broke, what to change), attached to that match's log.
- **Right-click → Make this an agent task** almost anywhere in the app: an auto step, a state, a log moment, a Changes finding, a spot in a sim replay. The task records exactly what you pointed at.

Add your name so the agent and team know who to ask. In the browser, feedback downloads as a file to put in `tools/mayhem/review/`.

## The board

| Column | Meaning | You |
| --- | --- | --- |
| **New** | Waiting for an agent. | Can decline. |
| **Agent planning** | An agent took it. | |
| **Plan to approve** | The agent wrote a plan. | **Approve plan** or **Ask for a different plan**, with a note. |
| **Agent working** | Plan approved, code changing. | |
| **Ready to check** | The change is done. | **See what changed on the robot** opens Changes for it; then **Accept the change** or **Not right, reopen**. |
| **Done** | Accepted, declined or just noted. | Can reopen. |

The Tasks tab badge counts plans and changes waiting for you. Each card shows its kind, author, what it's pinned to, the agent, and the risk level of its latest change. Open a card for the full text, the plan, each change with its findings, and the history.

## Connect an agent

Expand **Connect an agent** at the bottom of the page:

| Panel | What's there |
| --- | --- |
| **Share this project with an agent** | A copyable brief describing the project. |
| **Live file link** | **Save project file** links the project to a file in the robot repo; see [projects](/suite/projects#live-file-link-desktop). |
| **Connect over MCP** | Setup for the Mayhem MCP server. |
| **Command line** | `scripts/mayhem.mjs` commands. |
| **C++ library** | Export the routines as a C++ header for the robot. |
| **Project document** | The raw project JSON. |

Agents work tasks with the MCP tools `list_tasks`, `claim_task`, `propose_plan`, `report_progress` and `finish_task`, and can analyze logs, run scenarios and diff behavior with the others. See the [suite agent guide](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SUITE_AGENTS.md).

After an agent edits a routine, look at the field and graph, then preview it before running it on the robot.
