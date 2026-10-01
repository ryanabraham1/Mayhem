# Telemetry

`withTelemetry(true)` publishes these topics. NetworkTables DataLog captures them too.

| Topic | Type | Contents |
|---|---|---|
| `/Mayhem/trajectory` | `Pose2d[]` (struct) | The active trajectory, downsampled to about 150 poses. |
| `/Mayhem/reference` | `Pose2d` (struct) | The pose the follower is tracking right now, on the trajectory or on a bridge. |
| `/Mayhem/bridge` | `Pose2d[]` (struct) | The current recovery bridge. Empty when there is none. |
| `/Mayhem/state` | string | `FOLLOWING`, `BRIDGING`, `UNBEACHING`, `SETTLING`, `FINISHED`, or `IDLE`. |
| `/Mayhem/name` | string | Trajectory name. Segments appear as `Name[i]`. |
| `/Mayhem/time` | double | Trajectory clock [s]. |
| `/Mayhem/clockRate` | double | Time-dilation rate, from 0 to 1. |
| `/Mayhem/positionError` | double | Distance from the reference [m]. |
| `/Mayhem/lastPlanMs` | double | Duration of the last bridge plan [ms]. |
| `/Mayhem/bridgesPlanned` | double | Bridges planned during the current run. |
| `/Mayhem/onRoughTerrain` | boolean | Reference is inside a rough-terrain zone. |
| `/Mayhem/unbeaching` | boolean | Auto unbeach is driving the robot off a pile of fuel. |
| `/Mayhem/tiltDegrees` | double | Robot tilt from vertical [deg]; NaN without an IMU. |
| `/Mayhem/unbeachesStarted` | double | Unbeach maneuvers started during the current run. |
| `/Mayhem/unbeachTarget` | `Pose2d[]` (struct) | The point being driven toward while unbeaching. Empty otherwise. |

## AdvantageScope

In AdvantageScope, drag `trajectory`, `reference`, and `bridge` onto a 2D field next to your robot pose. Comparing `/Mayhem/reference` with the robot pose is the quickest way to spot a coordinate or alliance mistake.
