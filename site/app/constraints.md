# Constraints

Open the **Constraint** menu in the toolbar and pick a type, then **click the first waypoint and the last waypoint** it applies to. Click one waypoint and press <kbd>↵</kbd> to apply it to just that waypoint.

![The Constraint menu](/img/constraints.jpg)

| Constraint | Effect |
|---|---|
| Max velocity / acceleration / angular velocity | Limits between the two waypoints. |
| Straight line | The robot drives on the straight line between the two waypoints (± tolerance). |
| Point at | The robot faces a target. Drag the crosshair; it starts at the hub. |
| Keep in / Keep out region | Draw a polygon instead of picking waypoints. |
| Rough terrain | Draw a polygon over a bump. See [below](#rough-terrain). |
| Intake extended | The intake is out between the two waypoints, or in a zone. See [below](#intake-extended). |

Selecting a constraint highlights the part of the path it covers. In its panel you can change the limit, move it to other waypoints, or make a velocity limit apply **in a zone** (a drawn region) instead.

## Intake extended

The intake (set in **Settings → Robot**) is out between the two waypoints, or in a zone. The solver keeps the intake clear of obstacles and walls there as well as the bumpers. The field shows the intake on those waypoints and highlights that stretch of the path in amber.

On the robot, bind your deploy command to `AutoTrajectory.intakeExtended()`:

```java
traj.intakeExtended().whileTrue(intake.deploy());
```

## Rough terrain

Rough terrain can come from two places, and both end up in the exported path:

- **The field (recommended for bumps).** In [Field mode](/app/field), select an obstacle and turn on **Rough terrain on every path**. Every path that crosses it gets a span automatically, so it persists across all your paths. The REBUILT preset already marks its four bumps this way. Editing it marks existing paths out of date; regenerate them to refresh their spans.
- **A single path.** Draw a rough-terrain polygon with the constraint tool for terrain that only matters to one path.

The solver keeps its planned speed; the exported path marks the covered samples for the robot library. Where a field zone and a path zone overlap, the spans merge and the lower speed fraction and correction strength win. A span covers the time the robot *center* is inside the shape (plus 5 cm), so draw it over the part of the bump the robot center crosses.

On the robot, MayhemLib pauses collision detection and replanning in the zone, slows the path clock to follow the robot's progress, and softens feedback. After leaving the zone, it temporarily raises the vision-trust signal. Event markers continue to fire as trajectory time advances. See [Bump recovery](/lib/recovery#rough-terrain-zones).

## Tips

- Prefer a **position tolerance** on a waypoint over a tight constraint when you can. It gives the solver room to find a path.
- A **Point at** constraint conflicts with a fixed heading at a waypoint inside its range. Loosen the heading tolerance or make the heading free.
