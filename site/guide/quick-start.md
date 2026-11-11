# Your first suite routine

Run the development app with `cd app`, `pnpm install`, then `pnpm dev` and open `http://localhost:5173`. The suite needs no Python solver for this workflow.

1. Click the project name in the top bar and create a project.
2. On **Robot**, enter your dimensions, drive limits and typed inputs.
3. On **Autonomous**, create a routine, drag its starting robot, then choose **Pose**, **Translation** or **Handoff** and click the field to place goals.
4. Select a step and adjust its heading, arrival tolerances, callbacks, conditions and watchdogs in the inspector.
5. Play **Path only** to inspect the full pose sequence. Switch to **Full routine** and set simulated inputs and callback results under **Inputs & events** to check conditions and failures.
6. Choose **Export project** for a JSON backup. In desktop, **Agents → Save project file** creates a live file link for agent collaboration. Review **Agents → C++ export** and integrate callbacks in your robot code before hardware testing.

[Full suite guide →](/guide/suite)

Suite `.mayhem.json` files are separate from classic `project.mayhem` / `.mtraj` projects. For the solver and Java MayhemLib workflow, follow [Your first classic trajectory](/guide/classic-quick-start).
