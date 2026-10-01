# Introduction

Mayhem plans time-optimal swerve autonomous paths for the 2026 FRC game, REBUILT. You place waypoints on the field; the solver finds the fastest path your drivetrain can physically drive while avoiding obstacles. **MayhemLib** then follows that path on the robot and recovers if the robot is bumped off it.

![The Mayhem desktop app](/img/overview.jpg)

## The three parts

| Part | What it does |
|---|---|
| **Desktop app** (macOS, Windows, Linux) | Where you build paths. You set up your robot and the field, place waypoints, add constraints and event markers, and press **Generate**. |
| **Solver** (Python, CasADi + IPOPT) | Runs inside the app. It builds each trajectory as a time-optimal control problem, tries several routes around obstacles in parallel and keeps the fastest verified one. |
| **MayhemLib** (Java vendordep) | Runs on the roboRIO. It loads the `.mtraj` files the app writes and follows them, with feedback, time dilation and bump recovery built in. |

## What makes it different

- **Real limits.** Motor torque-speed curves, stator current limits, wheel traction (μ), mass and moment of inertia all constrain the solution. If your robot can't accelerate that hard, the path won't ask it to.
- **Obstacles.** Draw polygon or circle obstacles. The collision check uses the robot's real bumper rectangle as it rotates, not a circle around it.
- **Useful failures.** A path that can't be solved isn't just "failed". The app lists what's wrong ("Waypoint 3 heading conflicts with point-at constraint") and marks the spot on the field.
- **Bump recovery.** On the robot, MayhemLib notices a hit and plans the fastest feasible bridge back onto the trajectory. It deliberately does not avoid obstacles while recovering, which keeps planning well under a millisecond on a roboRIO.

## Workflow

1. [Install](/guide/installation) the app and the robot library.
2. Create a project [inside your robot code](/app/projects) at `src/main/deploy/mayhem/`.
3. Enter your [robot's real numbers](/app/robot) and check the [field](/app/field).
4. [Build a path](/app/paths), add [constraints](/app/constraints) and [markers](/app/markers), and press **Generate**.
5. [Check it](/app/checking) on the timeline and graphs.
6. Write a few lines of [robot code](/lib/quick-start) to run it.

The fastest way through all of that is [Your first auto](/guide/quick-start).

::: tip Coming from Choreo?
MayhemLib's API is modeled on ChoreoLib's `AutoFactory` / `AutoRoutine` / `AutoTrajectory` / `AutoChooser`, so most code ports with few changes. The main difference is that you don't write a controller. See [Coming from Choreo](/lib/from-choreo).
:::

## Scope

Mayhem targets the **2026 season** (REBUILT, WPILib 2026 on roboRIO 2, Java 17) and CTRE Phoenix 6 swerve (a Tuner X `CommandSwerveDrivetrain`) with AprilTag-fused pose. Other drivetrains work through the `AutoFactory` constructor. WPILib 2027 and SystemCore support come later.
