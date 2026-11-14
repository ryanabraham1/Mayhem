---
name: mayhem-tasks
description: Work the team's Mayhem task queue for this robot repo - feedback people left in the Mayhem app (Tasks page) about how the robot behaves. Picks up new feedback, investigates it with the logs and the simulation, asks the person at this terminal when something is unclear, proposes a plain-English plan, and once a person approves it, fixes the robot code in a closed loop (code, sim, read the log, fix), records the sim proof on the task and reports the change. Use when asked to check, work or run the Mayhem tasks, the task queue, or robot feedback, including from /loop.
---

# Work the Mayhem task queue

People on the team don't read code. They leave feedback in the Mayhem app and review what the robot *does*. Each run of this skill advances the queue by one step and stops; run it on a loop (`/loop 10m /mayhem-tasks`) to keep the queue moving.

You run in a person's terminal. The app is where they give feedback, approve plans and check changes; this terminal is where you and they talk.

## Where to run

In a checkout of the robot repo that has the Mayhem integration (`tools/mayhem/machines.json`; the `mayhem/suite-integration` branch, at `~/Downloads/FRC_Offseason_2026-suite-integration` on Ryan's Mac). Feedback lives in that checkout's `tools/mayhem/review/`. If the current folder has no `tools/mayhem/machines.json`, stop and say which folder to open instead.

## Tools

Use the Mayhem MCP tools (`mcp__mayhem__list_tasks`, `get_task`, `claim_task`, `propose_plan`, `report_progress`, `finish_task`, `release_task`, `run_scenarios`, `behavior_diff`, `log_states`, `log_anomalies`, `log_what_changed`, `log_table`, `analyze_log`). If they are not available, call the same tools from the shell, from a Mayhem checkout (`$MAYHEM_DIR`, default `../Mayhem` next to this repo):

```sh
node "${MAYHEM_DIR:-../Mayhem}/scripts/mayhem.mjs" tool list_tasks '{"repo": "."}'
```

`repo` is this repository's root. Your agent name is `claude` unless the user gave you one; use it for every task call.

## Each run: one step

1. `list_tasks` with `status: ["open", "claimed", "plan", "approved", "review", "done"]`. Handle the first that applies, then stop and report what you did in two or three sentences.
   - **A task you claimed went back to "claimed"** with `planDecision.approved: false`: read `planDecision.note`, revise, `propose_plan` again.
   - **A task approved for you** (`status: "approved"`, `agent` is you): implement it (below).
   - **A "done" task with commits whose branch has no pull request yet** (`gh pr list --head agent/<task id> --state all` is empty): open the pull request (below).
   - **A new task** (`status: "open"`): investigate and propose a plan (below). Skip thumbs-up items (status "noted") and anything outside robot code. If it has commits in `changes`, a person sent your change back: their reason is the last `history` entry ("reopened it: ..."). Say in the new plan what will be different this time.
   - **Waiting on people** (only "plan" or "review" tasks are yours): say so and stop. Never approve or accept your own work.
2. If nothing to do, say "Queue empty" and stop.

## Ask here when you need a person

Feedback is short and written in a hurry. When it leaves out something only a person knows (which button, which match, what "slower" means, whether a side effect is acceptable), ask in this terminal, one clear question, and end the run. The answer arrives here; the next run carries on with it. Do not guess, do not put questions into a plan, and do not leave them on the task: nobody answers there.

Put what you were told into the plan in the person's own words ("Sam said: only while intaking"), so whoever approves it sees what the plan rests on. If the question is about one task, the others in the queue don't wait for it.

## Investigate, then propose a plan (no code changes yet)

1. `get_task`. The `anchor` holds the context: `logPath` and `time` (a moment in a match log), `revision` (the commit the robot ran), `pose` (field spot), `routine` and `step` (an auto step), `machine`/`state`/`transition`, `scenario` (a sim proof run), `behavior` (a finding on the Changes page). Driver forms have `form` answers.
2. `claim_task`.
3. Reproduce before you explain:
   - From a log: `log_states` and `log_what_changed` around `anchor.time`, `log_table` of the suspects.
   - From the robot's behavior: `run_scenarios` with an inline scenario that does what the person described (steps like `"hold A 2"`, `"stick left 0 1"`, `"down LT"`; expectations like `"Shooter mode never SHOOTING"`). A failing scenario is the best evidence.
4. If you can't tell what the person wants, ask (above) and stop.
5. `propose_plan` in plain English, for drivers and mentors who don't read code: what will change on the robot, what will stay the same, and how they can check it (the scenario name, the button, the auto). Mention anything safety-related up front (current limits, CAN IDs, brake/coast, motor direction, gear ratios). One short paragraph plus up to three bullets. No code, no file names.
6. Stop. A person approves it on the Tasks page; a later run picks it up. They cannot send a plan back without saying what to change.

## Implement an approved task (closed loop)

1. Start a branch from the task's `base` (or `origin/main`): `git switch -c agent/<task id> <base>`. Never work on `main` or on a teammate's branch.
2. Change the code to do exactly what the approved plan says. If the plan turns out wrong, `release_task` with a note or propose a new plan instead of improvising.
   - Autos and state machines: edit `robot.mayhem.json` / `tools/mayhem/machines.json` with the Mayhem tools (`apply_machine_spec`, `import_mtraj_route`), then regenerate `MayhemProject.h` with `tools/mayhem/export.sh`. `behavior_diff` reports red if you forget.
   - Plain values: keep them as named constants in the subsystem's `*Constants.h` so people can see and edit them in the app.
3. Loop until it works: `run_scenarios {after: "WORKTREE", scenarios: [<your reproduction>], names: [...]}`, read the result's `timeline` (and `log_states` on its log when a state machine misbehaves), fix, repeat. A state that flickers back and forth is always a bug.
4. Add your reproduction to `tools/mayhem/scenarios.json` with its expectations, so it stays fixed.
5. `behavior_diff {before: "<base>"}`. It lists what a person will be shown: values, controls, machines, autos, and every other code file you touched ("Other robot code changed"). Anything there the plan didn't mention is a problem: undo it or propose a new plan. Never remove or loosen a team scenario to make a run pass; that is reported too.
6. Commit with a short plain subject and the trailer `Mayhem-Task: <task id>`, push the branch, then `report_progress` with the commit and a one-line summary.
7. Record the sim proof on the commit: `run_scenarios {task: "<task id>", agent: "<you>"}`, with no `names` or `groups`, so every button, every auto and every team scenario runs on the commit against the task's base. The tool writes the result onto the task; that record is what the person checks, so don't describe a proof in a note instead. Any difference in a driver button's outcome that the plan didn't call for is a regression: fix it, commit, `report_progress` and run this again.
8. `finish_task`. If the reply has a `warning`, the newest commit has no complete proof: go back to step 7. Changes that touch only auto paths (every path finishes) or no robot code are accepted automatically; everything else, including any change to logic, waits for a person in "Ready to check".

## Open the pull request (after a person accepts, or auto-accepted)

`gh pr create --base main --head agent/<task id>` titled with the task title. The body: the feedback (who, what, where), the approved plan, the recorded sim proof result (`changes[].proof` on the task), and the `behavior_diff` risk. Keep the `Mayhem-Task: <task id>` line in the pull request's commit message (also when it is squashed): the app finds the change in `main`, on the robot and in logs by it. People review behavior on the Mayhem Changes page, not the diff. Do not merge it yourself.

After the merge the app follows the change by itself: in `main`, on the robot once someone deploys and checks, then in the first log recorded on that code. There is nothing for you to do, and you never deploy.

## Rules

- Never change behavior the plan didn't mention; same driver inputs must give the same outcomes.
- Never deploy to the robot.
- Never commit generated build files or `src/main/deploy/mayhem-build.json`.
- If the build or the sim toolchain fails, report it on the task with `release_task` and a note instead of guessing.
