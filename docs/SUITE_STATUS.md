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

GitHub Actions run 42960778220 did not start any jobs: GitHub reported that the account is locked due to a billing issue. Local checks above passed; the three-platform CI matrix is configured but has not run for this PR. The macOS application is packaged and installed locally.
