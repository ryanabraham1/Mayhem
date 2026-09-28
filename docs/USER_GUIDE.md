# Mayhem user guide

Mayhem plans time-optimal swerve autos for the 2026 game (REBUILT). You place waypoints; the solver finds the fastest path your drivetrain can physically drive while avoiding obstacles. MayhemLib then follows it on the robot and recovers if the robot gets bumped.

## 1. Create a project

A project is a folder with `project.mayhem` (robot, field, named commands) and one `<path name>.mtraj` file per path.

The easiest setup is to create the project **inside your robot code** at `src/main/deploy/mayhem/`. Every save is then already "deployed": WPILib copies the folder to the roboRIO on the next code deploy. If you keep the project somewhere else, set **Settings → Project → Deploy folder**. Generated paths are copied there automatically whenever they are saved. A brief success banner confirms each path save.

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
| Intake | Which side it deploys from, how far it reaches past the bumper, its width (0 = the whole side) and offset. Only counts where a path has an **Intake extended** constraint. |

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
| Pose | W | Adds a waypoint with a position **and** a heading (drawn as the robot box with a heading knob). |
| Translation | T | Adds a waypoint with a position only; the robot may face any direction (drawn as a dot). |
| Guide | G | Shapes the route without constraining it (e.g. "go left of the hub"). |

New waypoints always go at the **end** of the path. To change the order, drag waypoints in the sidebar list (grab the handle on the left), or use the ↑/↓ buttons. Constraints and markers stay attached to the waypoints they referenced.

Drag a pose waypoint's round knob to set its heading (hold ⇧ to snap). Select a waypoint to edit it in the floating panel:

- **Pose / Translation / Guide** switches the type.
- **Position tolerance** (circle or box) lets the solver end anywhere inside, which often turns an infeasible path into a feasible one.
- **Stop here** brings the robot to rest. The first waypoint always stops.
- **Split here** lets robot code run the path in pieces and branch between them.

Press **Generate** (⌘↵). The solver tries several routes around obstacles in parallel and keeps the fastest. The path is colored by speed and fades when you edit inputs, until you regenerate.

If generation fails, a panel lists what's wrong (e.g. "Waypoint 3 heading conflicts with point-at constraint") and a red pin marks the spot. Click an issue to jump there.

While paths are generating, click **Cancel generation** in the top bar to stop running solves and clear any paths waiting in a **Generate all** batch. Previously generated paths remain available.

## 5. Constraints, markers and pose variables

**Constraints.** Open the **Constraint** menu in the toolbar and pick a type, then **click the first waypoint and the last waypoint** it applies to. Click one waypoint and press ↵ to apply it to just that waypoint.

| Constraint | Effect |
|---|---|
| Max velocity / acceleration / angular velocity | Limits between the two waypoints |
| Straight line | The robot drives on the straight line between the two waypoints (±tolerance) |
| Point at | The robot faces a target (drag the crosshair; it starts at the hub) |
| Keep in / Keep out region | Draw a polygon instead of picking waypoints |
| Rough terrain | Draw a polygon over a bump. The solver keeps its planned speed; the exported path marks the covered samples for the robot library. |
| Intake extended | The intake (Settings → Robot) is out between the two waypoints, or in a zone. The solver keeps the intake clear of obstacles and walls there as well as the bumpers. The field shows the intake on those waypoints and highlights that stretch of the path in amber. On the robot, bind your deploy command to `AutoTrajectory.intakeExtended()`. |

Selecting a constraint highlights the part of the path it covers. In its panel you can change the limit, move it to other waypoints, or make a velocity limit apply **in a zone** (a drawn region) instead.

On rough terrain, MayhemLib pauses collision detection and replanning, slows the path clock to follow the robot's progress, and softens feedback. After leaving the zone, it temporarily raises the vision-trust signal. Event markers continue to fire as trajectory time advances. The expected speed fraction is used for the estimated delay; it does not reduce the solver's planned speed.

**Event markers** (sidebar **+**): a name plus a command bound in robot code, placed at a waypoint with a time offset. A zone marker stays active until its end point.
- *If bump recovery skips it*: fire when rejoining (default), fire immediately, or skip.
- *Must hit*: recovery can never jump past this marker's time.

**Pose variables** are named poses shared by every path in the project, for example a shooting spot or an intake station.
- **Create one:** open **Pose variables** beside the Constraint toolbar button, then click **New pose variable**. If a waypoint is selected, the new variable starts at its pose and links to it. You can also click **Save as** in the waypoint panel.
- **Link a waypoint:** use the waypoint panel's *Pose variable* menu. Linked waypoints show a ring.
- **Move one:** moving a linked waypoint, or editing the variable, moves it in **every** path that uses it. Those paths are marked out of date.

**Folders**: organize paths with the folder button in the *Paths* header, and drag paths into folders.

**Flip top ↔ bottom**: right-click a path and choose *Flip across blue alliance* to mirror it across the field's long center line (e.g. a route over the top bump becomes the same route over the bottom one), or *Duplicate flipped* to keep the original and add the mirrored copy. Waypoints, point-at targets, and keep-in/keep-out/zone regions are mirrored, then the path is re-solved against the obstacles on that side. Waypoints linked to a pose variable relink to one at the mirrored pose if it exists, otherwise they unlink.

## 6. Check it

- The timeline at the bottom plays the path (Space). Tick marks show waypoints (gray) and markers (amber).
- The graph button shows speed, acceleration, estimated motor current per module (against your current limit) and wheel force.
- **Blue / Red** previews the red-alliance version. Paths are always authored for blue and flipped at runtime.

### Fuel sim

**Fuel sim** in the toolbar simulates the FUEL on the field during playback. Robots push it around, and an extended intake takes it in only as fast as its intake rate. Everything else it touches gets shoved, the way a real intake bulldozes part of a pile. The timeline shows how much fuel we're holding and keeps running after the robots stop until the pushed fuel has rolled to rest.

- **Our robot** uses its solved path and its **Intake extended** spans. Set its *intake rate* (fuel per second) and *capacity* (0 = no limit) in the Fuel sim panel. An out-of-date path doesn't take part until you generate it again.
- **Other robots**: add allies and opponents from the panel. Each drives a smooth curve through its points at a set max speed and acceleration, facing along the curve, with its intake out at the front. Select one to edit it: drag its points or its whole path, double-click the field to add a point at the end, ⇧-click a point to remove it, and press Delete to remove the robot. The copy button mirrors it to the other alliance.
- Fuel bounces off enabled obstacles (the hubs, trench walls and towers) and the field walls. It rolls over the bumps.
- The other robots and intake settings are saved in the project file. They never make a path out of date, and the solver ignores them.
- It's a 2D, top-down model. Fuel doesn't stack or fly, and robots don't collide with each other. The FUEL properties come from FIRST and AndyMark's 2026 Scoring Element Testing Report (215 g, 5.91 in). Rolling friction and bounce values are estimates.

## 7. Run it on the robot

See [lib/README.md](../lib/README.md). In short:

```java
AutoFactory autoFactory = CtreSwerve.autoFactory(drivetrain).withTelemetry(true);
autoFactory.bind("intake", intake.intakeCommand());

AutoRoutine routine = autoFactory.newRoutine("Hub Cycle");
AutoTrajectory cycle = routine.trajectory("Hub Cycle");
routine.active().onTrue(Commands.sequence(cycle.resetOdometry(), cycle.cmd()));
cycle.atTime("shoot").onTrue(shooter.shootCommand());
return routine;
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Waypoint N's bumpers overlap …" | The robot at that pose hits an obstacle. Move or rotate it, or add a position tolerance. |
| "Waypoint N's extended intake overlaps …" | The intake is out at that waypoint and hits something. Rotate the waypoint, move it, or end the intake range earlier. |
| A heading or point-at is infeasible | Loosen the heading tolerance, make the heading free, or add distance or time between waypoints. |
| The path goes around the wrong side of an obstacle | Add a **guide** point on the side you want and drag it into place in the waypoint list. |
| Slow to generate | Fewer waypoints, a larger sample spacing (Settings → Path solver), or fewer route candidates. |
