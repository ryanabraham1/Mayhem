# Suite implementation status

The suite is a working development foundation, not a finished replacement for every robot software tool. The legacy planner remains accessible. This checklist makes the remaining work explicit.

| Area | Implemented | Still required for a finished release |
| --- | --- | --- |
| Human autonomous editing | Dark/light themes, Pose/Translation labels, original Mayhem vector field, full field framing, placement tools/double click, pose/start dragging, heading handles, inspector, undo/redo, reorder, routine management | More interaction polish, broader keyboard/accessibility and narrow-window review, richer branch editing and reusable robot actions |
| Pose-based autos | Shared measured-arrival controller, independent heading, moving handoffs, per-goal limits, typed conditions, explicit timeouts/failures | Robot tuning, dynamic-goal authoring, target-selection/avoidance helpers, real-robot integration and tests |
| Agent workflows | Public JSON, open extensions/custom actions, CLI/MCP, revision-checked linked files, C++ export | Complete machine-readable schema/version migration policy, broader tool integration and automation tests |
| C++ | Standalone controller, optional executor, WPILib command, log/NT observers, generated example | Robot project example and easy distribution/vendordep, platform build coverage, physical testing |
| State viewing | Auto-linked graph, arbitrary machine manifests, typed inputs/guards, recorded replay and read-only NT4 live subscription | Larger graph layouts, more source navigation, correlated auto/mechanism recording views |
| Local logs | WPILOG worker parsing, channel plots, synchronized cursor/playback/field, IndexedDB originals, analysis exports | Indexed streaming for large recordings, more WPILib/AdvantageKit structured data formats, multirun comparisons and richer annotations |
| Robot collection | Native SFTP list/select/download, size stability checks, optional polling/new-name filter, external-viewer button | Real roboRIO Ethernet test, Windows/Linux external-viewer verification, progress/cancel/resume for long transfers |
| Diagnostics/power | Evidence-linked findings, coverage reporting, voltage/current/energy, brownouts, faults, disconnections, loop overruns/state chatter | Team-configurable rules and per-device power budgets, baselines/comparison, real match log validation |
| Team cloud | Live team library, private storage, selected downloads, upload-only device queue/retry, actual hosted AdvantageScope Lite with selected-log handoff; synthetic upload/download tested | Real match log validation, storage retention controls, upstream Lite preview updates |
| Release | Mayhem 0.9.2 packaged, signature checked and installed in /Applications; production team website deployed | Apple notarization, Windows/Linux package verification, published releases |

## Review loop hardening (2026-11-13, working tree after v0.9.44)

- The behavior review no longer reports a change to code it cannot read as empty. Snapshots carry a content id for every file that ends up on the robot (`src/main/**`, `vendordeps/*.json`, `build.gradle`); files that changed and that no other finding explains are listed as **Other code** (yellow). A removed or loosened sim proof scenario is a finding too. `finish_task` therefore auto-accepts only path-only changes and changes that touch no robot code; a logic change always waits in "Ready to check".
- Tasks: sending a plan or a change back needs a note; a person can take a task back from an agent that stopped; the board names the agents on the queue and when each last acted, and marks tasks an agent has held for a day; unreadable task files and a task that changed under a click are reported instead of failing silently. The 4-second task poll no longer redraws the app when nothing changed.
- Overview leads with what waits for a person (plans to approve, changes to check). Choosing the robot code folder opens the repo's own `robot.mayhem.json`, linked. Changes remembers the compared versions and starts on `main` → the branch when nothing is edited locally. "Connect an agent" has a copyable prompt that puts any agent on the queue.
- three.js loads with the first 3D replay instead of with the app (main bundle 1.45 MB → 0.87 MB).
- A sim proof belongs to a commit: `run_scenarios {task}` and the app's Sim proof tab record the run on the task's commit (`changes[].proof`), and the person checking sees that run, or "not run" with a button that runs it. `finish_task` warns when the newest commit has no complete proof.
- After accept, a task shows where its change is: accepted, in main (squash merges found by the `Mayhem-Task:` line), on the robot (the build stamp at the last check), in a log (the commit the log says it ran). Log summaries now keep that commit.
- Agents stay in the person's terminal: the skill (`integrations/skills/mayhem-tasks`, packaged with the tools) has them ask there when feedback is unclear. There is no in-app agent launcher and no question thread on tasks.

Verification: 321 frontend/core/CLI tests, TypeScript and production build, 34 Playwright tests (8 that need a real robot repo skipped), 11 Rust tests and strict Clippy pass. Screens were checked in light and dark at 1440 and 1024 px against a clone of the team's robot repo. The 3D replay spec and `sim --task` (40 scenarios, recorded on the task) ran against a cached build of the team's robot. Not verified: a packaged desktop build of these changes, a sim proof that needs a fresh robot build, a real pull request merge and deploy followed through the delivery steps, and anything on a physical robot.

## Documentation for the overhaul

[USER_GUIDE.md](USER_GUIDE.md) is the suite workflow guide: projects and file links, pose editing, preview modes, state inspection, log analysis, robot collection and agent handoff. Existing solver instructions are preserved in [CLASSIC_PLANNER.md](CLASSIC_PLANNER.md). The README, build instructions and VitePress site now route readers to the appropriate suite or classic workflow; classic screenshots are labeled. Documentation changes do not change the validation or release status recorded below.

## main is the known-good version; agent skill (2026-11-13, v0.9.37)

- On the robot now no longer keeps "known good" marks or a deploy history: what the robot runs is compared with the robot repo's `main` (`origin/main` when present), listing commits on the robot but not on main and how many newer main commits it lacks, with "What's different from main" (Changes) and "Put main back on the robot" (clean build of main, GradleRIO deploy, after confirmation).
- `node scripts/mayhem.mjs tool <mcp tool> '<JSON>'` runs any MCP tool from the shell.
- Robot repo: `.claude/skills/mayhem-tasks` works the task queue one step per run (investigate and propose a plan; after approval, implement on `agent/<task id>` in a closed sim loop, add the reproduction to scenarios.json, check nothing else moved, report, finish; open a PR once accepted). Run it on a loop with `/loop 10m /mayhem-tasks`.

## Robot explainer (2026-11-13, v0.9.36)

- Overview → **How the robot works**: the robot map from the code; click a part for what it does (the team's words, editable), its state machines and states with descriptions, its driver controls, its devices (CAN ID, brake/coast, limits), its live state when the robot is connected, and the latest commits that touched its code.
- Part descriptions are saved in the robot repo's `tools/mayhem/explainer.json`.
- Parts are matched to machines by name (a part's first word); parts without a matching machine show devices and changes only until the team describes them.

## On the robot now (2026-11-13, v0.9.35)

- Robot → **On the robot now** reads `deploy/mayhem-build.json` from the roboRIO over SFTP (commit, branch, uncommitted files, build time, who/where). (v0.9.35 compared it with a per-computer "known good" mark; since v0.9.37 it compares with `main`.) The latest log's health (red flags, battery, flickering states) is shown under it.
- Robot repo (`mayhem/suite-integration`): the build writes the stamp (git-ignored) and the robot logs it at boot as `Mayhem/Build`, so every log, and feedback left on it, names its commit.
- Comments on an auto step (Autonomous inspector) or a state/transition (State machines inspector) carry the routine, step and its target, or the machine, state and transition.
- Not verified against a physical roboRIO: the stamp download and the rollback deploy (GradleRIO `deploy -PteamNumber`).

## Feedback → agent tasks, approvals, closed-loop log tools (2026-11-13, v0.9.34)

- **Tasks** page (replaces Agents; agent setup is at its bottom): a board from New → Agent planning → Plan to approve → Agent working → Ready to check → Done, quick pit notes, a post-match driver form attached to a log, and a count on the Tasks tab when a plan or change waits for a person. Items are one JSON file each in the robot repo (`tools/mayhem/review/`).
- Feedback anywhere: Logs (comment at the playback moment, with the robot's pose), Changes (thumbs up/down on every finding; click the auto field), Sim proof (comment at the replay time; click the field). Each carries log, time, revision, pose, scenario.
- Agents: `list_tasks`, `get_task`, `claim_task`, `propose_plan` (waits for a person), `report_progress` (stores the commit's behavior_diff risk), `finish_task` (green changes auto-accepted, others wait), `release_task`, `add_feedback`. Changes → Summary shows "Why this change" from `Mayhem-Task:` commit trailers and reported commits.
- Closed loop: `run_scenarios` takes inline scenarios and `names`, and returns a per-scenario timeline digest; new `log_states` explains machine transitions with their inputs and collapses flickering; `log_anomalies` ranks flickering first and, like `log_events`, skips dashboard plumbing and NT copies by default.
- Not yet: sharing tasks beyond the repo (team-site sync), notifications outside the app.

## Sim proof (2026-11-13, v0.9.33)

- Changes → **Sim proof** builds both versions of the robot code with a probe test and runs, in the robot's own simulation: every controller button tapped and held, every auto on the full field, and the team's `tools/mayhem/scenarios.json` (plain steps and expectations; three starter scenarios are on `mayhem/suite-integration`). Results: pass/fail per expectation, before/after differences (machine states, drive mode, auto result, path), flickering states, and a before/after replay (field, time slider, state timelines). Agents: `run_scenarios` MCP tool, `mayhem.mjs sim`.
- Behavior review now reports red when `machines.json` or the autos changed but the generated robot code (`MayhemProject.h`) did not.
- Measured on this Mac: building a revision ~45 s, all 40 scenarios ~1 min (4 at a time), cached per commit. Not verified: Windows/Linux GradleRIO test task names, and per-motor configuration readback from the simulation (still read from source).

## Behavior review: Changes page (2026-11-13, v0.9.32)

- New **Changes** page compares two versions of the robot repo (branches, tags, commits, or uncommitted files) and shows what changes on the robot: driver controls (button → outcome from the state machines), state machines (one graph, added/changed/removed highlighted), values with units (constants, lookup tables, motor configurations), hardware on a top-view robot map (CAN IDs, direction, brake/coast, current limits, gear ratios, encoder offsets, duplicate CAN IDs), and autos (old and new path driven in the preview, drawn on the field). A red/yellow/green label summarizes it. Read from code, never from agent summaries (`app/src/suite/core/review/`).
- People can edit CAN IDs, limits, brake/coast, directions, ratios and other plain values from Hardware/Values; only that literal is rewritten in the working copy, with shared-value and CAN conflict warnings first.
- Agents: `behavior_diff` MCP tool and `mayhem.mjs review` CLI. The Agents page is now **Tasks**; the task board comes in a later milestone.
- Not yet: pressing every button in the robot's own simulation, the per-motor configuration readout from simulation, and before/after physics replays (milestone 2). Real robot repo: all 311 editable values in `mayhem/suite-integration` locate exactly; only shapes listed in SUITE_AGENTS.md are read.

## UI rehaul and team 3256 simulation (2026-11-11, current working tree)

- The whole suite UI was rebuilt: a top navigation bar (Overview, Autonomous, State machines, Logs, Robot, Agents, Settings) replaces the per-page layouts, with a new light/dark design system in `app/src/suite/suite.css` and shared primitives in `ui.tsx`. The 2,263-line `SuiteApp.tsx` was split into `useSuiteProject.ts` (project state, history, file link, preview) and one folder per page.
- The robot connection (`robot.tsx`, team number → `roborio-TEAM-frc.local`) and the log library plus collection/upload engine (`logLibrary.tsx`, `logSync.ts`) now live at app level, so automatic collection and uploads keep running on every page. Background polling no longer raises an error every 15 s while the robot is unplugged. New options: take every new log, collect from a local folder (simulation output, USB stick; new `list_local_logs` Tauri command), and remember the upload token.
- State machines: layered graph that wraps to fit, inputs that step a simulated machine, live NT lookups that also try `/AdvantageKit/…`, and "from any state" transitions collapsed into chips. Logs: verdict, finding timeline, Health / Power / Signals / Field tabs and a per-mechanism current ranking (`currentBreakdown` in `core/analysis.ts`, synced to 3256-Tools). The app now checks for updates itself.
- `examples/suite/team3256-offseason-2026.mayhem.json` models the team's C++ robot. Five practice matches ran through the robot's own simulation harness and produced real `.wpilog` files that import, analyze and replay on the Superstructure graph. Findings are in `examples/suite/team3256/README.md`.

Verification: 145 frontend tests, TypeScript and production build, strict Clippy and 5 Rust tests pass; the 3256 project validates and simulates through the CLI. Browser checks covered every page in light mode, preview playback, machine simulation, log import of synthetic and simulated robot logs, and state replay. Not verified: the Tauri desktop build of these changes (folder collection, native dialogs, updater), dark mode on every page, and anything against a physical roboRIO.

## PR validation and distribution (2026-11-11)

CI now builds real desktop bundles with the real frontend and frozen solver on macOS arm64/x64,
Windows and Linux, runs Rust tests/Clippy on each, and checks packaged-process startup. Playwright
tests the production browser build's auto authoring/export/reopen flow, WPILOG worker import and
IndexedDB persistence, state simulation, and navigation in both themes. Separate distribution
checks extract the new CLI/MCP and C++ archives, run them outside the checkout, and compile a
Node-generated routine against the extracted C++ headers. Actionlint checks the workflows;
`CI ready` aggregates every required validation job.

Releases resolve the tag to a commit SHA, run the same CI against that SHA before creating a
draft, package only that SHA, and verify the tag has not moved before publishing. Release assets
now include the new C++ and Node CLI/MCP archives and SHA-256 hashes alongside the existing Java
and Python tools. See `BUILDING.md` for commands and boundaries.

Local verification: 145 app tests, three Playwright workflows, five Rust tests and strict Clippy,
97 solver tests, Java Gradle tests, CMake/CTest, an installed CMake consumer, extracted archive
checks, and a macOS app bundle build/startup pass. This is not a successful hosted platform
matrix or physical robot validation. Native dialogs, SFTP and updater installation still need
interactive testing; startup smoke only detects early process exits.

## Reliability fixes (2026-11-10)

- The project-name button opens a real project picker: create a blank project, rename, duplicate, open a file, or switch saved local copies. Switching preserves outgoing edits and checks for competing windows. Open/Save file operations block competing editor mutations while their dialogs or writes are pending.
- The default **Path only** preview now runs the whole pose sequence instead of stopping at the sample's first mechanism state. It explicitly skips actions/guards and follows the first branch. **Full routine with inputs** exposes simulated callback results and typed sensor controls, checks failures/watchdogs, and latches completed callbacks. Trace exports carry their preview mode and assumptions. The CLI defaults to full routine behavior and accepts explicit action statuses.
- Autonomous steps display authored names and their kinds. Full routine playback identifies the callback or transition that is blocking it. Preview cycles stop at 600 seconds or 1000 execution events, bounding trace history memory.
- Log rows have one **AdvantageScope** desktop-open button; duplicate team-web and hosted Lite viewer links were removed. Background robot collection waits for unchanged file size across consecutive polls, then retains the native post-transfer stability check. Manual selected downloads remain immediate.
- The C++ executor also latches completed callbacks. CMake installation exports `Mayhem::Core`; a separate consumer verifies installed-package discovery and compilation. CI includes that consumer and native Rust tests.
- Changing the live robot address clears the previous connection and observations. Switching projects resets the state-machine workspace.

Verification: 137 frontend/core/CLI tests pass; the TypeScript/production frontend build passes; four Rust tests and strict Clippy pass; CMake/CTest controller and runner tests pass; installation plus a separate `find_package` consumer passes on macOS. Browser checks verified complete sample-path playback and switching to a new project and back. A local macOS `.app` was bundled with ad-hoc signing and without updater artifacts. The app was installed to `/Applications/Mayhem.app`; its binary matches the tested bundle and its ad-hoc code signature verifies. The previous installation is preserved at `artifacts/Mayhem-before-suite-reliability-2026-11-10.app`. Relaunch Mayhem to load the update. Notarization, Windows/Linux package verification, physical robot testing, and published release signing remain outstanding.

These changes do not constitute physical robot validation or a published cross-platform release. Prior deployment/install statements below describe the earlier development pass.

## Operating boundaries

Browser imports/playback work without the desktop app. SFTP collection, local external viewers, and file-linked agent collaboration require the desktop build. NT4 connections from a hosted HTTPS website may be blocked by browser local-network/mixed-content restrictions; the desktop app or localhost is the intended direct robot connection.

WPILOG imports currently support version 1.0 scalars, numeric/boolean arrays, and selected common WPILib pose/translation/rotation/chassis-speed structs. Unknown types are reported, not silently interpreted. Per-file limits are 250 MB and two million decoded samples. The app keeps original files intact. This is not yet a full AdvantageScope replacement.

The preview does not execute custom robot code or validate physical avoidance. The new controller has not been driven on a physical robot. The team website and private storage are deployed; synthetic recordings verify transport/playback, not the accuracy of diagnostics on real matches.

Next product priority: keep improving the supervised auto editor, then validate a real robot/log round trip, and expand diagnostics from the team's own match recordings. Useful later suite additions include configuration/tuning comparison, run-to-run regression reports, a robot health checklist based on logged signals, and linked code/build/run provenance.

## Verification in this development pass (2026-11-10)

- Installed desktop: 0.9.2 includes dark mode and simple Pose/Translation labels. The local external-viewer button opens actual installed AdvantageScope rather than Data Log Tool.
- App: all 121 tests pass; TypeScript and production browser build pass. Browser checks verified goal dragging, double-click placement, per-routine starting-pose edits, undo, synthetic log import/playback/finding navigation, and live state/input/guard inspection.
- Native shell: `cargo clippy --locked -- -D warnings` passes; all four Rust tests pass, including preservation of the disk revision after a conflicting save.
- C++: controller and generated-routine checks compile with Clang C++17 and pass. Browser/native controller traces agree. Optional WPILib adapters were syntax-checked against installed 2026 headers. CMake was unavailable on this machine, so the documented CMake/CTest command was not run locally; CI now includes that path on three platforms.
- Live protocol: the browser and CLI received actual NT4 values from a local WPILib ntcore server. This is a protocol test, not a physical robot test.
- Team website: production Next build and targeted ESLint pass; all 21 Node tests pass, including scope handoff and log-route checks. Production migration and native upload/shared download/playback are verified with a labeled synthetic recording. Actual hosted AdvantageScope graphs and desktop AdvantageScope launch with the selected log were checked. Physical robot collection remains unverified.

## Hosted CI limitation

GitHub Actions runs 42960778220 and 43065322863 did not start jobs: GitHub reported that the
account is locked due to a billing issue. The latter run's check annotations were rechecked on
2026-11-11 and still report the lock. Local checks above passed; the expanded hosted platform
matrix must pass after the account is unlocked before this PR is considered merge-ready.
