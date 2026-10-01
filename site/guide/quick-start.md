# Your first auto

This walks from an empty project to a robot driving a Mayhem path. Each step links to the page with the details.

## 1. Create a project in your robot code

Open Mayhem, click **New project**, and choose your robot project's `src/main/deploy/mayhem/` folder (create it if it doesn't exist). Every save is then already "deployed": WPILib copies the folder to the roboRIO on your next code deploy.

[More on projects →](/app/projects)

## 2. Enter your robot's real numbers

Open **Settings → Robot** and fill in mass, moment of inertia, bumper size, wheelbase, wheel radius, motor and gear ratio, and the stator current limit. The optimizer treats these as hard physical limits, so the closer they are to the truth, the better the path matches what the robot can do.

![Robot settings](/img/robot-settings.jpg)

[Robot configuration →](/app/robot)

## 3. Place waypoints and generate

Press <kbd>W</kbd>, then click the field to add pose waypoints (position and heading). Press **Generate** (<kbd>⌘</kbd><kbd>↵</kbd>). The path is colored by speed.

![Waypoints and a generated path](/img/waypoints.jpg)

[Building paths →](/app/paths)

## 4. Add what the path needs

Use [constraints](/app/constraints) to limit speed, point at a target or keep out of a region, and [event markers](/app/markers) to run robot commands at points along the path. Scrub the timeline to [check the result](/app/checking).

## 5. Add MayhemLib to the robot

Install the vendordep with **WPILib: Manage Vendor Libraries → Install new libraries (online)**:

```
https://ryanabraham1.github.io/Mayhem/MayhemLib.json
```

## 6. Run the path

For a CTRE Tuner X swerve, create the factory once and build a routine:

```java
AutoFactory autoFactory = CtreSwerve.autoFactory(drivetrain)
    .withTelemetry(true);                       // NetworkTables under /Mayhem

autoFactory.bind("intake", () -> intake.run()); // marker named "intake" runs this

AutoRoutine routine = autoFactory.newRoutine("Hub Cycle");
AutoTrajectory cycle = routine.trajectory("Hub Cycle");
routine.active().onTrue(Commands.sequence(cycle.resetOdometry(), cycle.cmd()));
cycle.atTime("shoot").onTrue(shooter.shootOnce());
return routine;
```

For a one-path auto without triggers:

```java
Commands.sequence(autoFactory.resetOdometry("Straight"), autoFactory.trajectoryCmd("Straight"))
```

[MayhemLib quick start →](/lib/quick-start) · A complete robot project: [examples/robot-2026](https://github.com/ryanabraham1/Mayhem/tree/main/examples/robot-2026)
