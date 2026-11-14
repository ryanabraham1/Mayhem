# Your first routine

Install the [desktop app](/guide/installation), or run the browser version from a checkout with `cd app && pnpm install && pnpm dev` and open `http://localhost:5173`. No Python solver or robot is needed.

1. Click the project name in the top bar and create a project.
2. On **Robot → Specs & limits**, enter the robot's size and drive limits, and add any typed inputs your routine will check (sensors, game state).
3. On **Autonomous**, create a routine and drag the starting robot into place.
4. Choose **Pose** (`W`), **Any heading** (`T`) or **Pass through** (`G`) and click the field to place goals, or **Draw** (`D`) the route freehand.
5. Select a step to set its heading, stop/handoff behavior and limits. Use **Advanced** for callbacks, conditions and watchdogs, and **Whole path → Map → Generate** to solve speed caps and corner radii.
6. Press **Preview** (Space). **Path** drives the route; **With actions** waits on your simulated inputs and callback results under **Inputs & events**.
7. Check the badge above the field says **Fits in auto**, then export the C++ (Overview's match-ready checklist or **Tasks → Connect an agent → C++ library**) and register your callbacks in robot code.

[Everything in Autonomous →](/suite/autonomous)

Suite `.mayhem.json` projects are separate from classic `project.mayhem` / `.mtraj` projects. For the solver and Java MayhemLib workflow, follow the [classic trajectory quick start](/guide/classic-quick-start).
