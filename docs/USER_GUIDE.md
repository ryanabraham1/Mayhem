# Mayhem user guide

Mayhem plans time-optimal swerve autos for the 2026 game (REBUILT). You place waypoints; the solver finds the fastest path your drivetrain can physically drive while avoiding obstacles. MayhemLib then follows it on the robot and recovers if the robot gets bumped.

## 1. Create a project

A project is a folder with `project.mayhem` (robot, field, named commands) and one `<path name>.mtraj` file per path.

The easiest setup is to create the project **inside your robot code** at `src/main/deploy/mayhem/`. Every save is then already "deployed": WPILib copies the folder to the roboRIO on the next code deploy. If you keep the project somewhere else, set **Settings → Project → Deploy folder** and use **Deploy** in the top bar.

New projects start with the 2026 REBUILT field.

## 2. Configure the robot (Settings → Robot)

Enter the real values. The optimizer uses them as hard physical limits:

| Setting | Notes |
|---|---|
| Mass, moment of inertia | Mass with bumpers and battery. Use **Estimate MOI** if you don't have a CAD value. |
| Bumper | Distances from robot center to each bumper face. Collision checks use this rectangle as it rotates. |
| Wheelbase, track width | Module positions. Order is FL, FR, BL, BR (Tuner X default). |
| Wheel radius, μ | μ≈1.0–1.3 on carpet. Traction is often the limiting factor. |
| Motor, gear ratio, stator limit | Sets the torque-speed curve and current cap. |
| Planning voltage | Plan below 12 V (11 V default) so feedback has headroom. |

The panel on the right shows derived limits (free speed, max acceleration) and what limits your acceleration.

## 3. Edit the field (Field mode)

Switch to **Field** in the top bar. Every obstacle here applies to all paths.

- **Polygon** (P): click corners; click the first corner, double-click or press Enter to finish.
- **Circle** (C): drag from the center.
- Select an obstacle to drag it, drag its corners, double-click an edge to add a corner, or ⇧-click a corner to remove it.
- Checkboxes in the sidebar enable or disable obstacles. The REBUILT bumps and the overhead trench openings start disabled, since most robots drive over or under them. Enable the trenches if your robot is taller than 22.25 in.
- **Copy to other alliance** (flip icon in the obstacle panel) mirrors an obstacle using the field symmetry.
- **Clearance margin** is extra space the robot keeps from that obstacle.

## 4. Build a path (Paths mode)

| Tool | Key | What it does |
|---|---|---|
| Select | V | Select or drag. Drag empty space to pan, scroll to zoom. |
| Waypoint | W | Click to add. Near the existing path it inserts between neighbors; otherwise it appends. |
| Guide point | G | Shapes the route without constraining it (e.g. "go left of the hub"). |
| Point at | P | Click a target; the robot faces it over a range of waypoints. |
| Speed zone | Z | Draw a region with a max speed (edit the value in the panel). |
| Keep out | K | A region only this path avoids. |

Drag a waypoint's round knob to set its heading (hold ⇧ to snap). Select a waypoint to edit it in the floating panel:

- **Exact vs. Guide only**; a **position tolerance** (circle/box) lets the solver end anywhere inside, which often turns an infeasible path into a feasible one.
- **Heading fixed/free**, with an optional tolerance.
- **Stop here**: the robot comes to rest. The first waypoint always stops.
- **Split here**: the robot code can run the path in pieces and branch between them.

Press **Generate** (⌘↵). The solver tries several routes around obstacles in parallel and keeps the fastest. The path is colored by speed. When you edit inputs the path fades to show it is out of date; turn on **Auto-generate** to regenerate after every edit.

If generation fails, a panel lists what's wrong (e.g. "Waypoint 3 heading can't be reached in time") and a red pin marks where. Click an issue to jump there.

## 5. Constraints and markers

- **Constraints** (sidebar **+**): max velocity, max acceleration, max angular velocity, point-at, keep-in, keep-out. Each applies at one waypoint, between two waypoints, or inside a drawn zone.
- **Event markers**: a name plus a command bound in robot code, placed at a waypoint with a time offset. A zone marker stays active until its end point.
  - *If bump recovery skips it*: fire when rejoining (default), fire immediately, or skip.
  - *Must hit*: recovery can never jump past this marker's time.

## 6. Check it

- The timeline at the bottom plays the path (Space). Tick marks show waypoints (gray) and markers (amber).
- The graph button shows speed, acceleration, estimated motor current per module (against your current limit) and wheel force.
- **Blue / Red** previews the red-alliance version. Paths are always authored for blue and flipped at runtime.

## 7. Run it on the robot

See [lib/README.md](../lib/README.md). In short:

```java
var auto = CtreSwerve.autoFactory(drivetrain).withTelemetry(true);
auto.bind("intake", intake.intakeCommand());
var cycle = auto.trajectory("Hub Cycle");
cycle.atMarker("shoot").onTrue(shooter.shootCommand());
return Commands.sequence(cycle.resetOdometry(), cycle.cmd());
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Waypoint N's bumpers overlap …" | The robot at that pose hits an obstacle. Move or rotate it, or add a position tolerance. |
| A heading or point-at is infeasible | Loosen the heading tolerance, make the heading free, or add distance or time between waypoints. |
| The path goes around the wrong side of an obstacle | Add a **guide point** on the side you want. |
| Slow to generate | Fewer waypoints, a larger sample spacing (Settings → Path solver), or fewer route candidates. |
