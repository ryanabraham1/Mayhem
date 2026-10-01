# Troubleshooting

When generation fails, the app lists what's wrong and pins the spot on the field. Click an issue to jump to it. These are the common ones.

| Symptom | Fix |
|---|---|
| "Waypoint N's bumpers overlap …" | The robot at that pose hits an obstacle. Move or rotate it, or add a position tolerance. |
| "Waypoint N's extended intake overlaps …" | The intake is out at that waypoint and hits something. Rotate the waypoint, move it, or end the intake range earlier. |
| A heading or point-at is infeasible | Loosen the heading tolerance, make the heading free, or add distance or time between waypoints. |
| The path goes around the wrong side of an obstacle | Add a **guide** point on the side you want and drag it into place in the waypoint list. |
| Slow to generate | Use fewer waypoints, a larger sample spacing (Settings → Path solver), or fewer route candidates. |
| A "Likely unsolvable" panel appears while generating | The solver found a probable conflict early. Click an issue to inspect it, or **Stop** to end generation and keep the diagnosis. |

## Simple input errors

Some mistakes are caught before any optimization runs, with the exact waypoint index:

- missing waypoints
- fixed poses outside the field or overlapping an obstacle
- fixed headings that can't satisfy a point-at target
- a straight line through an obstacle, or a fixed waypoint off the straight line
- a fixed waypoint enclosed by obstacles

## A failed solve is not deployable

A failed solve is not deployment-ready. Edit the path or constraint and generate again. For why the solver behaves this way, see [How the solver works](/reference/solver).

## On the robot

For problems when running paths (wrong place, mirrored on red, markers not firing), see [MayhemLib troubleshooting](/lib/troubleshooting).
