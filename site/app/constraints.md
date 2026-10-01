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

Draw a rough-terrain polygon over each bump. The solver keeps its planned speed; the exported path marks the covered samples for the robot library.

On the robot, MayhemLib pauses collision detection and replanning in the zone, slows the path clock to follow the robot's progress, and softens feedback. After leaving the zone, it temporarily raises the vision-trust signal. Event markers continue to fire as trajectory time advances. See [Bump recovery](/lib/recovery#rough-terrain-zones).

## Tips

- Prefer a **position tolerance** on a waypoint over a tight constraint when you can. It gives the solver room to find a path.
- A **Point at** constraint conflicts with a fixed heading at a waypoint inside its range. Loosen the heading tolerance or make the heading free.
