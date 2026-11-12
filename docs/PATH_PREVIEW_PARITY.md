# Path preview parity

Mayhem previously previewed its robot feedback-controller approximation. BLine
Web instead previews ideal kinematics: stopping-distance translation/angular
speeds, vector acceleration limits, geometric rotation progress, target handoffs
before movement, and final position/heading snapping. Cross-track PID and P-based
braking in the old Mayhem preview produced different corners and stopping shapes.
Its 40 ms timer also displayed two 20 ms samples at once, producing 25 Hz jumps.

Standard pose/translation chains now use the BLine-Web 1.0.0-derived preview
engine at commit `1e440b419dc33499e447fbca4ddc2fea69497b71`. Its dependency closure
and BSD license live in `app/src/suite/core/pathing`. The adapter maps the
routine start to an explicit starting waypoint, rotation/event markers to native
elements, and per-step limits to BLine ranged constraints. The runtime consumes
its samples for both path-only and full-routine previews, preserving callbacks,
conditions, explicit stops and watchdogs. Playback uses requestAnimationFrame
and shortest-angle interpolation while exported simulation samples stay at 20 ms.

Compare the same start, targets, rotation markers, profiled-rotation settings,
handoff modes/radii, and limits. A Mayhem start is separate from its first target;
in BLine, the first authored translation/waypoint is the start. Placing only the
same target points without matching the start does not define the same path.
BLine labels the first integrated sample t=0; Mayhem records the actual starting
pose at t=0 and the first integrated sample at t=0.02. Its displayed duration is
therefore one 20 ms tick longer for the identical sequence of positions/headings.

The golden corpus in `app/tests/fixtures/bline-preview.json` was generated from
an untouched external upstream checkout, independently of the Mayhem adapter.
Regression tests compare every position, heading, active segment, and sample
count across straight braking, right angles, tight zigzags, retracing/wrapped
rotation, coincident anchors, and rotation/event marker cases. The browser test
checks display-frame motion, pause stability, rewind and resume.

Point-at/motion headings and explicit conditional open-ended handoffs are Mayhem
extensions and continue using the measured-pose controller preview. The native
C++ robot feedback follower is unchanged. Matching ideal editor previews does
not establish identical real-robot performance.
