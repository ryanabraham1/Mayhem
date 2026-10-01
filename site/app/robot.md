# Robot configuration

Open **Settings** (the sliders icon, top right) and choose **Robot**. Enter the real values: the optimizer uses them as hard physical limits.

![Robot settings](/img/robot-settings.jpg)

| Setting | Notes |
|---|---|
| Mass, moment of inertia | Mass with bumpers and battery. Use **Estimate MOI** if you don't have a CAD value. |
| Bumper | Distances from robot center to each bumper face. Collision checks use this rectangle as it rotates. |
| Wheelbase, track width | Module positions. Order is **FL, FR, BL, BR** (the Tuner X default). |
| Wheel radius, μ | μ ≈ 1.0–1.3 on carpet. Traction is often the limiting factor. |
| Motor, gear ratio, stator limit | Sets the torque-speed curve and current cap. |
| Planning voltage | Plan below 12 V (11 V default) so feedback has headroom. |
| Intake | Which side it deploys from, how far it reaches past the bumper, its width (0 = the whole side) and offset. Only counts where a path has an [Intake extended](/app/constraints#intake-extended) constraint. |

The panel on the right shows the derived limits (free speed, max acceleration, max angular velocity) and what limits your acceleration, for example `friction`.

## Other settings

| Page | What's there |
|---|---|
| **Path solver** | Sample spacing, route candidates and the solve time limit. A larger spacing or fewer candidates makes generation faster. |
| **Project** | The deploy folder. |
| **Appearance** | Light or dark theme. |
| **Shortcuts** | Keyboard shortcuts. |
| **About & updates** | Version and update check. |

::: warning Match the real robot
The same mass, moment of inertia, wheel radius and max speed also drive MayhemLib's feedforward. If they don't match the real robot, the feedforward and force feedforward on the robot will be wrong. See [Tuning the follower](/lib/tuning).
:::
