# Building paths

Switch to **Paths** in the top bar. A project holds many paths; the sidebar lists them. Use the folder button in the *Paths* header to organize them into folders, and drag paths into folders.

![Waypoints and the waypoint panel](/img/waypoints.jpg)

## Tools

| Tool | Key | What it does |
|---|---|---|
| Select | <kbd>V</kbd> | Select or drag. Drag empty space to pan, scroll to zoom. |
| Pose | <kbd>W</kbd> | Adds a waypoint with a position **and** a heading (drawn as the robot box with a heading knob). |
| Translation | <kbd>T</kbd> | Adds a waypoint with a position only; the robot may face any direction (drawn as a dot). |
| Guide | <kbd>G</kbd> | Shapes the route without constraining it (for example, "go left of the hub"). |

New waypoints always go at the **end** of the path. To change the order, drag waypoints in the sidebar list (grab the handle on the left), or use the ↑/↓ buttons. Constraints and markers stay attached to the waypoints they referenced.

## Editing a waypoint

Drag a pose waypoint's round knob to set its heading (hold <kbd>⇧</kbd> to snap). Select a waypoint to edit it in the floating panel:

- **Pose / Translation / Guide** switches the type.
- **Position tolerance** (circle or box) lets the solver end anywhere inside, which often turns an infeasible path into a feasible one.
- **Stop here** brings the robot to rest. The first waypoint always stops.
- **Split here** lets robot code run the path in pieces and branch between them. See [Splits and alliance flipping](/lib/splits-and-alliance).
- **Pose variable** links the waypoint to a [shared pose](/app/markers#pose-variables).

## Generating

Press **Generate** (<kbd>⌘</kbd><kbd>↵</kbd>), or **Generate all** for every path. The solver tries several routes around obstacles in parallel and keeps the fastest. The path is colored by speed and fades when you edit its inputs, until you regenerate.

To stop, click **Cancel generation** in the top bar. It stops running solves and clears any paths waiting in a **Generate all** batch. Previously generated paths remain available.

### When generation fails

If generation fails, a panel lists what's wrong (for example, "Waypoint 3 heading conflicts with point-at constraint") and a red pin marks the spot. Click an issue to jump there.

If the solver finds a likely conflict while it is still checking other routes, an amber **Likely unsolvable** panel appears early. Click an issue to inspect its location, or click **Stop** in that panel to end generation and keep the diagnosis visible.

See [Troubleshooting](/app/troubleshooting) for the common messages.

## Flip top ↔ bottom

Right-click a path and choose **Flip across blue alliance** to mirror it across the field's long center line (for example, a route over the top bump becomes the same route over the bottom one), or **Duplicate flipped** to keep the original and add the mirrored copy.

Waypoints, point-at targets and keep-in, keep-out and zone regions are mirrored, then the path is re-solved against the obstacles on that side. Waypoints linked to a pose variable relink to one at the mirrored pose if it exists, otherwise they unlink.
