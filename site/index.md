---
layout: home

hero:
  name: Mayhem
  text: Time-optimal swerve paths for FRC
  tagline: Place waypoints. Mayhem finds the fastest path your drivetrain can actually drive, around real obstacles, and gets your robot back on it after a bump.
  image:
    src: /img/overview.jpg
    alt: The Mayhem desktop app with a generated path on the 2026 REBUILT field
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Download
      link: https://github.com/ryanabraham1/Mayhem/releases/latest
    - theme: alt
      text: GitHub
      link: https://github.com/ryanabraham1/Mayhem

features:
  - icon: ⚡
    title: Physics-based and fast
    details: Motor torque-speed curves, stator current limits, wheel traction, mass and inertia are hard limits in the optimizer, so paths are fast and drivable.
    link: /app/robot
    linkText: Configure your robot
  - icon: 🧭
    title: Routes around obstacles
    details: Draw polygon and circle obstacles. Collision checks use the robot's real, rotating bumper rectangle, and the path is verified with a swept check.
    link: /app/field
    linkText: Edit the field
  - icon: 🔎
    title: Tells you what's wrong
    details: When a path can't be made, Mayhem names the waypoint or constraint that's the problem and pins it on the field, early, while other routes are still being tried.
    link: /app/troubleshooting
    linkText: Troubleshooting
  - icon: 🤖
    title: MayhemLib on the robot
    details: A Java vendordep for WPILib 2026 with an API modeled on ChoreoLib. It follows paths with per-module force feedforward and needs no controller from you.
    link: /lib/quick-start
    linkText: Robot quick start
  - icon: 💥
    title: Bump recovery
    details: If the robot is knocked off its path, MayhemLib detects the hit and takes the fastest feasible bridge back onto the trajectory.
    link: /lib/recovery
    linkText: How recovery works
  - icon: 🟣
    title: Fuel sim
    details: Play a path back with the 2026 FUEL on the field, with allies and opponents driving their own paths, to see how an intake and a route interact.
    link: /app/fuel-sim
    linkText: Try the fuel sim
---
