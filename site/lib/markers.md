# Event markers

The app offers two kinds of markers:

- **Instant markers** fire once, when the trajectory clock crosses their time.
- **Zone markers** ("during" markers) start at `t` and end at `endT`.

When a marker fires, the factory looks up the command bound to the marker's **command** name. If the app left the command field empty, the lookup uses the marker name. The factory then schedules that command. When a zone ends, its command is cancelled. The command is also cancelled if the trajectory command is interrupted. If no command is bound to a name, the marker is ignored, but `atTime(name)` still works.

```java
autoFactory.bind("intake", () -> intake.run());      // zone: runs while inside the zone
AutoTrajectory t = routine.trajectory("HubCycle");
t.atTime("score").onTrue(shooter.shootOnce());       // trigger style, no bind needed
t.recovering().onTrue(leds.flashRed());
```

## Rules

- Bound commands **must not require the drivetrain**. If one did, it would interrupt path following.
- Markers follow the **trajectory clock**, not the match clock. When time dilation slows the reference, markers wait for the robot too.
- A marker at `t = 0` fires when the command starts. A marker at the very end fires when the clock reaches the end, before the robot finishes settling.
- A marker that sits exactly on a split point belongs to the following segment. It fires when that segment starts.

## When recovery jumps over a marker

A [recovery bridge](/lib/recovery) can jump over part of the trajectory. Each marker in the jumped-over window follows its policy, which you set in the app:

| Policy | Behavior |
|---|---|
| `fireAtJoin` (default) | Fires when the robot rejoins, in order. |
| `fireImmediately` | Fires as soon as the bridge is planned. |
| `skip` | Doesn't fire. Zones with this policy neither start nor end. |

A zone whose end falls inside the jumped window is closed at the join. Markers flagged **must-hit** bound the join window, so they are never jumped over.
