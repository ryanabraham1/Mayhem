# BLine Web preview and constraint engines

Unmodified source from https://github.com/edanliahovetsky/BLine-Web
commit `1e440b419dc33499e447fbca4ddc2fea69497b71` (version 1.0.0), retrieved 2026-11-11.
BSD-3-Clause; see LICENSE. Includes the complete dependency closures for
`simulatePath` and `autoRadiiCapSolveInput`, including the joint speed/radius
optimizer, corner geometry, and rotation feasibility checks. It includes the tank simulator
and field configuration because the upstream swerve entry point imports them.

Keep these files unchanged. Mayhem model conversion and execution integration
belong in ../../blinePreview.ts, ../../constraintGeneration.ts and ../../runtime.ts. This is the editor's ideal
kinematic preview, not the robot's feedback controller or a physics simulation.
