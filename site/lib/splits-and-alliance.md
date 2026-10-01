# Splits and alliance flipping

## Split segments and branching

Split points in the app divide one solved path into chained segments. Usually the split sits at a stop waypoint. `routine.trajectory(name, i)` returns segment `i` with its time rebased to start at 0. The rebasing also covers the segment's events, waypoint times, and must-hit times. The segment end is always a must-hit point, so recovery never skips past it.

```java
AutoRoutine routine = autoFactory.newRoutine("HubCycle");
AutoTrajectory toHub = routine.trajectory("HubCycle", 0);
AutoTrajectory toIntake = routine.trajectory("HubCycle", 1);
routine.active().onTrue(Commands.sequence(toHub.resetOdometry(), toHub.cmd()));
toHub.done().onTrue(shooter.shootOnce().andThen(
    Commands.either(toIntake.cmd(), Commands.none(), intake::hasRoom)));
return routine;
```

Only call `resetOdometry()` on the first segment. Later segments start where the previous one ended. On a trajectory without splits, split index 0 is the whole trajectory.

## Alliance flipping

Author trajectories in **blue-alliance coordinates**. The red version is derived from the field symmetry stored in the file:

- `ROTATIONAL` (REBUILT 2026) maps (x, y, θ) to (L − x, W − y, θ + π). Vectors negate, and ω stays the same.
- `MIRROR` maps (x, y, θ) to (L − x, y, π − θ). vx negates, ω negates, and the left and right module forces swap (FL↔FR, BL↔BR).

Recovery data flips together with the path, so recovery works on both alliances. To override the alliance, for example with a dashboard toggle during practice, use `withAllianceFlip(...)`. `MayhemTrajectory.flipped()` is also public if you need it directly.
