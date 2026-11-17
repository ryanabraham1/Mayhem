# Suite status

What works, and what has not been verified yet. Release notes on [GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases) and the git history record how each part got here; this page is only the current state.

| Area | Works | Not verified / still to do |
| --- | --- | --- |
| Branch review (Changes) | Every branch not in `main`, read from code: driver controls, state machines, values, hardware, autos, other code. Red/yellow/green risk from the diff. Pull request status and merge. Delivery after merge: in main, on the robot, in a log | A real pull request merged, deployed and followed through every delivery step |
| Sim proof | Both versions built and run in the robot's own simulation on the full field (every button, every auto, the team's `tools/mayhem/scenarios.json`), recorded as a git note on the commit; 2D and 3D replay | Windows/Linux GradleRIO test task names; per-motor configuration readback from the simulation (still read from source) |
| Autonomous | Pose-to-pose routines on the REBUILT field, BLine-derived preview, inspector, undo/redo, C++ export | Dynamic-goal authoring, target-selection helpers, the controller driven on a physical robot |
| State machines | Layered graph, simulated inputs, live NT4 subscription, log replay | Larger graph layouts, source navigation |
| Logs | WPILOG parsing in a worker (structs from the log's schemas, files up to 512 MB, large logs collapsed then thinned with peaks kept), verdict and findings, Health / Power / Signals / Field tabs, current ranking, battery sag, `log_diagnose` for agents | Diagnostics checked against real match logs (only sim logs so far); run-to-run comparison for people; team-configurable rules and power budgets; protobuf (`proto:`) entries |
| Robot | Build stamp on the robot vs `main`, every value editable, SFTP and folder log collection, team upload with retry | Stamp download, "Put main back on the robot" deploy and SFTP collection against a physical roboRIO |
| Agents | Node CLI and MCP (`scripts/mayhem.mjs`), project brief, file link, `behavior_diff`, `run_scenarios`, log tools | Schema version migration policy |
| C++ (`lib-cpp/`) | Header-only controller, executor, WPILib command, log/NT observers, `mayhem::sim` physics; CMake/CTest on three platforms; MayhemCpp vendordep | Physical robot testing |
| Team cloud | 3256-Tools `/logs` library, private storage (uploads gzipped, about a third of the size), hosted AdvantageScope Lite with selected-log handoff | Real match log validation, storage retention controls |
| Release | Desktop installers for macOS (arm64, x64), Windows and Linux from the Release workflow; self-update | Apple notarization and Windows code signing; Windows/Linux packages installed and used by hand |

## Operating boundaries

- Browser imports and playback work without the desktop app. SFTP collection, external viewers, the robot repo review, the sim proof and file-linked agent work need the desktop build.
- NT4 connections from a hosted HTTPS website may be blocked by browser local-network or mixed-content rules; the desktop app or localhost is the intended direct robot connection.
- The preview does not run custom robot code or check physical avoidance. The sim proof does, in the robot's own simulation.

## Removed

- After v0.9.59: the classic trajectory planner (Settings → Open classic planner), its Python CasADi/IPOPT solver sidecar, the Java MayhemLib vendordep and its example robot. Releases up to v0.9.59 still contain them; the hosted `MayhemLib.json` stays on GitHub Pages.
- After v0.9.45: the Tasks page, task files, plan approval, driver form, pit notes, task MCP tools and the `mayhem-tasks` skill. People talk to agents in the agent's chat and review the branch here.
