# Usability audit, 2026-11-10

User feedback supersedes the earlier “usable release” characterization. Automated checks and isolated demonstrations do not establish a complete usable application.

## First repair pass (0.9.3)

- Auto routine sidebar, project export and preview controls are scoped to Autos. Other tools own the available space. Navigation labels remain visible at compact widths.
- The robot/project title is an actual button opening Robot setup; the decorative dropdown arrow was removed.
- Preview can replay stored frames from a scrubbed cursor instead of jumping to the end. Waiting on robot inputs, failure and completion are visible. Leaving Autos pauses preview.
- Log collection settings start collapsed, allowing the recording workspace to be visible.
- Project `extensions.logRules` and the CLI/MCP `policy` argument provide custom single-channel finding rules, configurable durations/severities/messages and an option to disable generic findings. Reopening a log applies changed rules. Combined/derived-signal rules are still missing.

## Required before calling the suite usable

- Complete a fresh human-created auto through editing, preview, saving/reopening and robot integration without implementation knowledge.
- Audit every visible control in each tool, including empty/error/offline/loading cases and keyboard interaction. A working isolated example is insufficient.
- Bring the auto movement model closer to the requested BLine behavior and verify the same behavior in browser preview and C++. Current point-to-pose control is not feature parity.
- Test actual robot log discovery, authorization and downloads over Ethernet. Validate findings using real team logs and fully separate on-robot settings from local analysis settings.
- Review state-machine manifest creation, connection, replay and transition inspection with actual robot data.
- Expand project-defined diagnostics to combined/derived signals and a visible policy management workflow; the first rule interface is deliberately described accurately, not as the final system.

## BLine comparison baseline

Primary references: https://bline-docs.pages.dev/concepts/path-elements/ and https://bline-docs.pages.dev/lib/follow-path/ . BLine has translation anchors plus independently placed rotation/event markers by geometric segment progress; translation control uses remaining polyline distance with cross-track correction; optional projected-progress handoffs avoid returning to a missed handoff circle. 2026-11-11 (later): the follower is now a port of BLine-Lib's FollowPath, RotationProgress and ChassisRateLimiter (BSD 3-Clause, credited in THIRD_PARTY_NOTICES.md), with BLine defaults and radius-only handoffs. Remaining differences: one handoff per 20 ms tick instead of draining several, per-step speed limits instead of ordinal ranges, no minimum rotation speed or rotation-speed ranges, and "free" (translation-only) final steps ignore heading unless a rotation target is on that segment. Browser and C++ behavior are checked to match by tests.
