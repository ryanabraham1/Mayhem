# Robot physics simulation (`mayhem::sim`)

A season-agnostic, header-only C++17 physics engine for FRC robots, in
`lib-cpp/include/mayhem/sim/`. It exists so robot code can run on stepped WPILib time
(`frc::sim::PauseTiming` / `StepTiming`) instead of Phoenix's wall-clock device sim: a 20 s
autonomous simulates in well under a second (a swerve with a bump and walls: ~20 ms per 20 s;
plus 500 game pieces: ~0.7 s), so agents can run hundreds of seeded Monte Carlo autos. It is
deterministic: the same inputs and seed give bit-identical results on the same build.

The core headers include only the standard library. Three optional adapters include vendor code:
`wpilib_sim.hpp` (WPILib 2026, C++20), `wpilib_apriltag.hpp` (also WPILib's apriltag library) and
`phoenix6.hpp` (Phoenix 6 v26 + WPILib, C++20).
Season-specific things (field layout, piece placement, scoring rules, robot IO wiring) live in
robot code and are built from these primitives.

## Headers

| Header | What it is |
| --- | --- |
| `sim/motor.hpp` | `DcMotor`: linear DC model (R, Kt, Kv, current, torque), published 12 V curves for Kraken X60/X44 (trapezoidal and FOC), Falcon 500 (both), NEO, NEO Vortex, NEO 550, Minion |
| `sim/talonfx.hpp` | `TalonFx`: Phoenix 6 TalonFX firmware emulator (requests, slot gains, Motion Magic, current limits, soft and hardware limits, neutral modes, followers, FOC/trapezoidal curves) and standalone profiles (`profile::Trapezoid`, `profile::Exponential`, S-curve) |
| `sim/canrange.hpp` | `CanRange`: CANrange that measures at its own rate (100 Hz for ShortRange100Hz) with ProximityThreshold/Hysteresis detection; a TalonFx can use it as a remote limit switch |
| `sim/battery.hpp` | `Battery`: open-circuit voltage + internal and wiring resistance, brownout below 6.75 V |
| `sim/mechanisms.hpp` | `Flywheel`, `Arm`, `Elevator` (a linear slide is one at 0 deg), `Roller`: implicit 1-DOF plants with hard stops |
| `sim/field.hpp` | `Terrain` (boxes, ramps, arbitrary-profile bumps), `Obstacles` (perimeter with chamfers, convex prisms with z ranges), `ContactEvent`, 2-D collision geometry |
| `sim/swerve.hpp` | `SwerveSim`: 6-DOF chassis on per-wheel spring contacts, elasto-plastic tires, belly-pan and bumper contacts, obstacles; `CollideRobots` |
| `sim/swerve_requests.hpp` | `swerve::SwerveRequestEmulator`: Phoenix 6 `SwerveRequest` + `SwerveModule` math applied to a `SwerveSim` |
| `sim/game_pieces.hpp` | `GamePieces`: sphere game pieces (flight with drag and Magnus, bounce/roll on terrain, ball-ball, ball-robot, intakes, goals) |
| `sim/cylinder_pieces.hpp` | `CylinderPieces`: rigid cylinder game pieces (2025 coral): 6-DOF, standing/lying/flying/held, carpet friction and rolling, tipping, walls and prisms, bumpers and mechanism colliders, piece-piece, an intake query |
| `sim/camera.hpp` | `AprilTagCamera`: PhotonVision-style AprilTag camera: pinhole projection of each tag's corners, detection limits (field of view, size, distance, view angle, motion blur, occlusion by prisms and robots), corner noise, multi-tag and two-solution single-tag PnP with ambiguity, frame rate and latency |
| `sim/sensors.hpp` | `SampledSignal<T>` (a status signal's update rate and CAN latency) and `GyroModel` (Pigeon2 yaw with scale error, bias drift, bias instability, noise and rate saturation) |
| `sim/rng.hpp` | `Rng`: portable seeded random numbers (`MAYHEM_SIM_SEED`) |
| `sim/wpilib_sim.hpp` | WPILib conversions (`ToPose3d`, `ToTranslations`, `ToPoses` for cylinder pieces, ...) and `SteppedTime` |
| `sim/wpilib_apriltag.hpp` | WPILib AprilTag adapter: `ToAprilTags(AprilTagFieldLayout)`, `ToPose3d` / `ToRigidPose` for camera poses (needs WPILib's apriltag library) |
| `sim/phoenix6.hpp` | Phoenix bridge: `FromPhoenix(TalonFXConfiguration)`, `FromApplied(ControlRequest)`, `FromRequest(SwerveRequest)` |

Vendor them with the other headers (`node scripts/mayhem.mjs vendor <robot> --snapshot ...`
copies `sim/` too) or use the MayhemCpp vendordep.

## Units and conventions

- SI everywhere: metres, kilograms, seconds, radians, newtons. Motor-facing values follow
  Phoenix: positions in rotations, velocities in rotations per second, voltages, amps.
- Field frame: x, y on the carpet, z up; yaw counter-clockwise from +x. Robot frame: x forward,
  y left, z up, origin at the frame centre on the floor (AdvantageScope's robot origin).
  `SwerveSim::Pose()`/`Pose3()` report that origin, not the centre of mass.
- Angles: roll/pitch/yaw follow WPILib `Rotation3d` (right-handed about x, y, z; positive pitch
  is nose down). `GyroYaw()` is continuous (unwrapped) like Pigeon2.
- Time: everything steps at a fixed dt. Use 1 ms (20 sub-steps per 20 ms robot loop); TalonFx
  closed loops then run at the device's 1 kHz. `SwerveSim` integrates internally at a fixed
  shorter sub-step (`Substeps()` per ms, typically 2), so longer Steps are still stable.
- Motor frames: `TalonFx::Step` takes the rotor position/velocity in the device's positive
  direction (after `inverted`) and returns torque in that direction. Wire each plant so positive
  device output moves it positive, as Phoenix users already do with `SimState.Orientation`.
  Followers convert from the leader's frame by themselves (see below).

## Running a robot on it

Per 1 ms (20 per robot loop), in this order:

```cpp
#include <mayhem/sim/battery.hpp>
#include <mayhem/sim/game_pieces.hpp>
#include <mayhem/sim/swerve_requests.hpp>

using namespace mayhem::sim;
const double bus = battery.BusVoltage();  // filtered bus, see below
// 1. Mechanisms: device update, then plant.
double tau = shooterTalon.Step(0.001, bus, flywheel.RotorPosition(), flywheel.RotorVelocity());
flywheel.Step(0.001, tau, shooterTalon.RotorDamping());
// 2. Robot-robot contacts, then drivetrains (they step their own 8 TalonFxs).
CollideRobots(robot, opponent);
robot.Step(0.001, bus, &terrain, &obstacles);
// 3. Game pieces (their reaction forces reach the robots' next Step).
pieces.Step(0.001, &terrain, &obstacles);
// 4. Battery from every device's signed supply current (regeneration is negative and counts).
battery.Step(robot.TotalSupplyCurrent() + shooterTalon.SupplyCurrent() + ..., 0.001);
```

Hand devices `battery.BusVoltage()`, not `Voltage()`. The devices see the bus from the previous
step, and a motor whose output is clamped to the bus draws more current when the bus drops; with
several such motors that explicit loop has a gain above 1, so an unfiltered bus swings between
~12 V and ~4 V every millisecond (it trapped a 4-motor shooter at half speed). `BusVoltage()` is
the terminal voltage low-passed with a 5 ms time constant (wiring inductance and controller bus
capacitance), which keeps the loop stable; `SetBusTimeConstant(seconds)` changes it, 0 disables
it. `Voltage()` stays the unfiltered terminal voltage.

Season code must also do what the roboRIO and Driver Station do, since the engine does not:
- **Brownout:** when `battery.Brownout()` (or your own threshold, `RobotController` defaults to
  6.75 V) is true, the roboRIO disables motor outputs: set every device to `NeutralOut` (or
  feed WPILib's brownout state from the sim) until the voltage recovers.
- **Disabled:** when the Driver Station is disabled, every motor goes neutral. Phoenix does this
  on the real device; in the sim, set each `TalonFx` to `NeutralOut` (honouring its neutral
  mode) whenever `frc::DriverStation::IsDisabled()`.

Between robot loops advance WPILib's clock by 20 ms with `SteppedTime` (`wpilib_sim.hpp`).

### Driving it from Phoenix

Mechanism motors: robot code keeps calling `SetControl` on its real `hardware::TalonFX`
objects. Each loop, read what each motor was told and hand it to its emulator:

```cpp
#include <mayhem/sim/phoenix6.hpp>
emulator.Configure(mayhem::sim::FromPhoenix(talonConfiguration));   // once
if (auto r = mayhem::sim::FromApplied(*talon.GetAppliedControl())) emulator.SetControl(*r);
```

`Follower`/`StrictFollower` come through with the leader's CAN ID; resolve it to the leader's
emulator with `TalonFx::SetLeader(&leader)` and step the leader first. A follower takes the
plant quantities in the leader's (mechanism) frame and applies Phoenix's rule internally: its
voltage is the leader's times (leader inverted) x (opposed) x (own inverted), so all motors on
one mechanism are wired to the plant the same way.

Swerve: Phoenix's `SwerveModuleImpl::Apply` reads the steer angle from status signals, which lag
under stepped time, so the module code cannot run in simulation. Convert the drivetrain's
current request and let the emulator reproduce Phoenix's math against the exact module angles:

```cpp
auto constants = swerve::DrivetrainConstants::From(params, TunerConstants::kSpeedAt12Volts.value());
swerve::SwerveRequestEmulator requests(constants);
swerve::ConfigureLikePhoenix(robot, constants, FromPhoenix(TunerConstants::steerGains),
                             FromPhoenix(TunerConstants::driveGains), TunerConstants::kSlipCurrent.value());
// every robot loop:
if (auto r = FromRequest(currentPhoenixRequest))
  requests.Apply(*r, robot, swerve::SwerveRequestEmulator::ParamsFrom(robot, now, operatorForward));
```

Non-Phoenix teams fill the request structs (`swerve::FieldCentric`, `ApplyRobotSpeeds`, ...)
directly.

## Composing a season

```cpp
Terrain terrain;
Obstacles obstacles;
obstacles.SetPerimeter(0, 0, 16.54, 8.07, /*chamfer*/ 0.0, /*wallHeight*/ 0.5);
// REBUILT bump: 1.128 m deep, 1.854 m wide, 0.1654 m tall, two 15-degree ramps to a ridge.
terrain.AddProfile(4.6, 2.5, 0, 1.854, {{-0.564, 0}, {-0.556, 0.0127}, {0, 0.1654}, {0.556, 0.0127}, {0.564, 0}});
// A trench arm: robots shorter than 0.5652 m drive under it, taller ones hit it.
obstacles.AddBox("trench_blue_left", 4.6, 7.4, 0, 1.2, 0.3, 0.5652, 1.0);
// The hub: a solid column robots and pieces bounce off, and a goal pieces fall into.
obstacles.AddCylinder("hub_blue", 4.6, 4.03, 0.6, 0, 1.4);
GamePieces pieces(BallParams{/*radius*/ 0.075, /*mass*/ 0.215});
GoalVolume hub;
hub.cx = 4.6; hub.cy = 4.03; hub.radius = 0.5; hub.zMin = 1.4; hub.zMax = 1.9;  // falling in
hub.onScore = [&](int ball, int) { score += 1; pieces.Place(ball, 8.27, 4.03); };
pieces.AddGoal(hub);
for (auto [x, y] : fuelSpots) pieces.Spawn(x, y);
int me = pieces.AddRobot(&robot);
IntakeZone intake{"intake", me, 0.42, 0.65, -0.3, 0.3, 0.0, 0.25};
intake.canAccept = [&] { return pieces.HeldCount(me) < 40; };
int intakeIndex = pieces.AddIntake(intake);   // pieces.Intake(intakeIndex).enabled = deployed;
// Shooting: pieces.LaunchHeld(me, exitPoint, exitVelocity, spin) and flywheel.RemoveEnergy(...)
```

Season dimensions above are examples; use the field drawings. Boxes in `Terrain` are things you
drive onto; anything taller than about a wheel radius that should stop a robot belongs in
`Obstacles` as well, because terrain only ever pushes up.

Visualize with AdvantageScope: log `ToPose3d(robot.Pose3())` as the robot,
`ToTranslations(pieces.FlyingPositions())` and `ToTranslations(pieces.GroundPositions())` as
game pieces, and component poses for an articulated model from `scripts/sim/cad-to-advantagescope.py`.

### Cylinder pieces (coral)

`CylinderPieces` simulates rigid cylinders, so an auto can show that a ground intake really gets
a coral instead of a proximity check. The defaults are 2025 coral (4.5 in OD, 11.875 in long,
1.5 lb, hollow PVC; carpet mu 0.8, restitution 0.2). A piece's axis is its pose's local x axis.

```cpp
CylinderPieces coral;                           // CylinderParams{} = 2025 coral
int me = coral.AddRobot(&robot);                // bumper box; reactions reach the robot
for (auto [x, y, yaw] : lyingSpots) coral.SpawnLying(x, y, yaw);
for (auto [x, y] : markSpots) coral.SpawnStanding(x, y);
// End effector and elevator, in the robot frame, updated every loop from the mechanisms.
MechanismCollider ee;
ee.robot = me;
ee.outline = {{0.30, 0.05}, {0.55, 0.05}, {0.55, 0.20}, {0.30, 0.20}};  // (x, z), extruded along y
ee.width = 0.35;
int eeIndex = coral.AddCollider(ee);
MechanismCollider carriage;
carriage.shape = MechanismCollider::Shape::Capsule;
carriage.robot = me;
carriage.a = {0.1, 0, 0.2}; carriage.b = {0.1, 0, 1.0}; carriage.radius = 0.04;
coral.AddCollider(carriage);
// Each 1 ms, after robot.Step:
coral.Collider(eeIndex).position = eeOriginInRobotFrame;      // + orientation, velocity
coral.Step(0.001, &terrain, &obstacles);
// Intake: pieces within 1 cm of the wheel line; season code decides whether the wheels get it.
for (const auto& n : coral.Near(wheelA, wheelB, 0.01))
  if (WheelsGrab(n)) { coral.Hold(n.index, me); held = n.index; break; }
coral.SetHeldPose(held, heldPose);                // every loop while carried
coral.Release(held, exitPose, exitVelocity);      // drop, eject or score
// Logging: Sim/Coral as Pose3d[] (AdvantageScope and the Mayhem 3D replay)
Logger::RecordOutput("Sim/Coral", ToPoses(coral.Poses()));
```

`ApplyImpulse(index, point, impulse)` lets wheel rules pull a piece before taking it, and
`LastRobotImpulse(robot)` reports what the pieces pushed on a robot. Polygon colliders are
convex outlines in their frame's x-z plane extruded along y; capsules are a segment and a radius.
Set `robotFrame = false` for a world-frame collider.

## Physics model

**Chassis.** A rigid body with mass, a diagonal inertia (yaw from `moiKgM2`; roll and pitch
default to a solid box of the bumper footprint and robot height) and gravity along -z,
integrated with semi-implicit Euler and an exact quaternion update at the fixed sub-step.

**Wheels.** Each wheel is a sphere of the wheel radius at its module, `cgHeightM - wheelRadius`
below the centre of mass. `Terrain::SphereContact` gives the exact distance to the surface, so a
wheel rolling over a crest sees a smoothly rotating normal. The normal force is a stiff
spring-damper (`tireNormalStiffness`, carpet plus tread, 2e5 N/m default), clamped at zero: a
wheel can lift off, and loads redistribute by themselves (longitudinal and lateral load transfer
under acceleration, one side climbing a bump). Static loads on a 10-degree slope match the
rigid-body closed form within 0.3%.

**Tires.** Forces act in the local terrain plane; the drive direction is the steer angle
projected onto it. Friction is elasto-plastic: a tangential bristle spring
(`tireTangentialStiffness`) holds true static friction up to `muStatic * N`, so a parked or
X-locked robot does not creep; beyond it the contact slides with the Stribeck curve
`mu(s) = muKinetic + (muStatic - muKinetic) exp(-|s| / slipVelocity)` on the combined slip
velocity (a friction circle). The wheel spin is integrated implicitly against the tire and the
motor's back-EMF damping. Drive torque reaches the wheel through `driveGearing` and
`driveEfficiency`; rolling resistance is `rollingResistance * N`.

**Modules.** The coupling ratio makes azimuth rotation turn the drive rotor (rotor turns =
`driveGearing` x wheel turns + `couplingRatio` x azimuth turns) and feeds drive torque back into
the azimuth, as on a coaxial module. The azimuth has its own inertia and tread scrub
(`muStatic * N * scrubRadius`).

**Chassis contacts.** The belly pan (a grid over `frameLengthX/Y` at `frameClearanceM`) and the
bumper edges (`bumperBottomM`, `bumperTopM`) are sampled against the terrain with penalty
springs and sliding friction: a robot can scrape, catch a bumper on a ramp face, or high-centre
on a crest with its wheels unloaded. `Beached()` is true when the frame carries more than
`beachedFrameFraction` of the weight, or the wheels carry less than `beachedWheelFraction` while
the frame touches, for longer than `beachedTimeS`. `SupportMargin()` and `TippedOver()` report
tipping. The bumper rectangle also collides with `Obstacles` whose z range overlaps the robot
(`SetRobotHeight` updates the top, e.g. when a hood rises), with penalty springs
(`bumperStiffness`), Coulomb friction, and a `ContactEvent` per obstacle per Step. Obstacle
forces are horizontal only: an overhead structure (a trench arm) stops a robot taller than its
`zMin` like a wall at the robot's top edge and never pushes it up. A roof grid at the current
robot height lets an overturned robot rest on its top.

**Robust contacts.** Teleports (odometry resets, `SetPose`) can start a robot inside an obstacle,
another robot, game pieces or the terrain, so no contact can launch it:
- obstacle and robot-robot springs are capped at 3x the robot's weight, terrain samples at 1x
  weight each and wheel springs at 8x weight;
- an overlap deeper than 3 cm (no real impact gets there) is resolved without forces: the robot
  is moved out at 0.5 m/s and its velocity into the obstacle removed (robot-robot overlaps
  separate at <= 0.5 m/s);
- game pieces inside a robot's bumpers are pushed out at <= 3 m/s; pieces never hold a robot up.
The cap makes hard impacts nearly inelastic: a robot hitting a wall at full speed stops within
about 2.5 cm without bouncing.

**Mechanisms.** Implicit 1-DOF integration: the motor's back-EMF damping (`RotorDamping()`) is
treated implicitly, Coulomb friction sticks exactly, and hard stops are either rigid or implicit
spring-dampers, so light, stiff mechanisms are stable at 1 ms. `Arm` and `Elevator` take a pitch
offset so a tilted robot changes the gravity torque. `Flywheel::RemoveEnergy` models a piece
taking energy out of a shooter.

**Game pieces.** Flight integrates gravity exactly (drag-free ranges match the closed form to
0.1 mm), plus quadratic drag and Magnus lift `0.5 rho A r Cm (spin x v)` (spin in rad/s, world
frame; backspin on a +x shot is -y). On the ground pieces roll with slope gravity scaled by the
rolling-inertia factor (5/7 for a solid ball) and rolling resistance; impacts bounce above
`restSpeed` with Coulomb-limited tangential friction. Ball-ball contacts use a counting-sort
spatial hash (500 balls cost ~40 us per 1 ms step on an M-series Mac). Robots push pieces with
restitution relative to the bumper's velocity and feel the reaction.

**Cylinder pieces.** Each piece is a rigid body (hollow-tube inertia) integrated with
semi-implicit Euler and an exact quaternion update; gyroscopic torque is ignored. Contacts are
solved with sequential impulses (Coulomb friction circle, restitution above `restSpeed`,
speculative contacts against tunnelling) and split-impulse position correction capped at
`maxPushSpeed`. Contact points lie on the real cylinder: the generator line nearest a surface
(clipped to a hull's other faces) and rim points at +-120 degrees from it, so a lying piece
touches along a line (rolls across its axis, slides along it at mu g), and a standing one rests on
a triangle whose apex is always its lowest rim point, so it pivots on the base edge when pushed
high and slides when pushed low (then trips when it stops, as mu 0.8 > r / h_cm). Rolling
resistance is a torque `rollingResistance * N * radius` about the axis. Prisms, bumper boxes
(`bumperBottomM` up to `robotBoxTopM` or `RobotHeight()`) and polygon colliders are convex hulls
tested on their face normals, which can stop a piece up to `r (sqrt 2 - 1)` (2.4 cm for coral)
early near a hull's edge; capsules use the exact point-to-cylinder distance. Piece-piece
contacts treat each piece as a capsule of the same radius and length: pieces rest on each other
side-on (crosswise, in a groove), not balanced end-on; `pieceContacts = false` turns them off.
Pieces at rest sleep until something moving comes within 2 cm. 20 coral with a robot, a plate
and a capsule collider cost ~17 us per 1 ms step on an M-series Mac.

**Mechanism colliders on pieces.** A collider's `stiffness` (N/m of overlap, default 3000) gives
a squeezed piece a normal force even when nothing moves toward it, as a compliant roller does, so
a roller or belt pressing on a coral grips it and drives it by friction. A capsule spinning about
its own axis (`angularVelocity` along the capsule, `position` on the axis) is a roller: its
surface moves at omega x r. Set `stiffness = 0` for a rigid plate.

## AprilTag camera

`AprilTagCamera` reports what a PhotonVision coprocessor would, from the robot's true pose:

```cpp
#include <mayhem/sim/wpilib_apriltag.hpp>
auto layout = frc::AprilTagFieldLayout::LoadField(frc::AprilTagField::k2025ReefscapeWelded);
mayhem::sim::CameraParams front;
front.robotToCamera = mayhem::sim::ToRigidPose(kRobotToFrontCamera);  // the Transform3d the robot uses
front.widthPx = 1280; front.heightPx = 800; front.horizontalFovRad = 1.2217;  // 70 deg
mayhem::sim::AprilTagCamera cam(front, mayhem::sim::ToAprilTags(layout));
// every 1 ms physics step, after the swerve step:
for (const auto& f : cam.Update(t, swerve, &obstacles))
  if (f.hasEstimate)  // hand it to the same filtering code the real VisionIO uses
    io.Publish(mayhem::sim::ToPose3d(f.robotPose), f.captureTime, f.tags.size(), f.ambiguity,
               f.averageTagDistanceM);
```

- **Projection and detection.** Each tag's four corners (6.5 in) go through a pinhole model
  (`fx`/`fy`/`cx`/`cy` from a calibration, or from the field of view). A tag is detected when all
  corners are in front of the lens and inside the image, its shortest edge is at least
  `minSidePx`, it is within `maxDistanceM` and `maxViewAngleRad` of its normal, no corner is
  behind an `Obstacles` prism or an extra `Occluder` (`AprilTagCamera::RobotOccluder(otherRobot)`),
  and its motion blur is below `maxBlurPx`. A tag on the face of its own structure is not hidden
  by that structure.
- **Noise.** Corners get Gaussian noise of `pixelNoisePx`, plus blur / sqrt(12) when the robot
  moves (blur = each corner's image velocity x `exposureS`; spinning at 1 rad/s smears a 70-degree
  1280 px camera by ~3.9 px at 4 ms).
- **Estimation.** The pose is solved from the noisy corners by Levenberg-Marquardt PnP, so the
  error comes from the geometry as on a real camera: it grows faster than distance, it is worst
  along the camera's orbit around coplanar tags, tags on faces at different angles (two reef faces)
  constrain it much better, and a single tag gives two solutions, the tag tilted either way. The
  lower-error one is reported with `ambiguity` = best / alternate reprojection error, so a nearly
  frontal or distant single tag sometimes reports the mirrored pose. Measured in the tests with
  0.5 px noise: two coplanar tags 0.7 m apart, 1.6 cm mean error at 1.5 m and 58 cm at 5 m (12 cm
  if they are on faces 60 degrees apart); one tag at 2.5 m, ambiguity 0.87 and half the frames
  mirrored seen frontally, 0.22 and none 40 degrees off its normal. Robot code should filter on
  ambiguity, tag count and distance exactly as it does on the real robot.
- **Timing.** Frames are captured at `fps` and arrive `latencyS` + uniform(0, `latencyJitterS`)
  later; `captureTime` is the timestamp for `AddVisionMeasurement`. `frameDropProbability` drops
  frames.
- `truthErrorM` and `truthYawErrorRad` compare the estimate with the truth, for tests and logs
  only.

The defaults (0.25 px noise, 30 ms latency, 4 ms exposure, 15 px minimum edge) are starting
estimates. To measure yours: park the robot at known spots 1-5 m from a tag and log PhotonVision's
estimates for a minute at each; set `pixelNoisePx` until the simulated spread matches. Latency is
PhotonVision's reported pipeline latency plus NetworkTables time; exposure is in the camera
settings.

## Sensor errors

`GyroModel` turns the swerve's true yaw into a Pigeon2 reading: `(1 + scaleError)` times each yaw
change, plus `biasRadPerS` and a random-walk bias (`biasRandomWalk`, rad/s per sqrt s), saturated
at 2000 deg/s, with white noise per sample, delivered at `updatePeriodS` (100 Hz, the Pigeon2
default) after `latencyS`. `SetYaw` re-zeroes the reading like Pigeon2 `SetYaw`. Feed robot code
`gyro.Yaw()` instead of `swerve.GyroYaw()`:

```cpp
mayhem::sim::GyroModel gyro{{.updatePeriodS = 0.004, .scaleError = 0.002, .biasRadPerS = 1e-4}};
gyro.Step(t, dt, swerve);  // each physics step
pigeonSim.SetRawYaw(units::radian_t{gyro.Yaw()});
```

Measure them: leave the robot still for five minutes and log yaw (the drift rate is
`biasRadPerS`, its wander `biasRandomWalk`); spin it ten turns in place against a mark on the
carpet (the error over 10 x 360 degrees is `scaleError`).

`SampledSignal<T>` models any value read over CAN or NetworkTables: it samples the truth every
`periodS` (the signal's update frequency) and delivers each sample `latencyS` later, with its
capture time. Wheel odometry, an absolute encoder or a distance sensor can go through it so robot
code sees what it would on the bus.

### Parameters worth measuring on the real robot

`massKg`, `cgHeightM` (affects load transfer and tipping), `moiKgM2` (SysId rotation),
`muStatic`/`muKinetic` (pull test with the tread on carpet), `wheelInertia` (include the
reflected rotor: `J_rotor * driveGearing^2`), `steerInertia`, `frameClearanceM`, bumper heights,
and each mechanism's inertia and friction. Tune them until simulated SysId and acceleration
tests match the real logs; the controller gains then transfer.

## Phoenix emulation fidelity

Matches Phoenix 6 (26.x) documentation and source where available:

- Mechanism units through `SensorToMechanismRatio * RotorToSensorRatio`; `SetMechanismPosition`
  latches at the next device update like `SetPosition`. ContinuousWrap takes the short way in
  the closed loop and in Motion Magic.
- Slot gains kP kI kD kS kV kA kG; kG `ElevatorStatic` or `ArmCosine` (cosine of mechanism
  position + `gravityArmPositionOffset`, in rotations); kS by velocity-reference sign or
  closed-loop-error sign; the slot selected per request.
- Voltage requests clamp to `PeakForward/ReverseVoltage` and the bus; duty cycle to the peak
  duty cycles; torque current to the peak torque currents.
- Stator limit: the voltage is clamped to back-EMF +/- limit x R, in both signs (regenerative
  current and brake mode too), after the bus clamp, and re-applied between device updates (the
  current loop is faster than 1 kHz). When the back-EMF exceeds the bus the required voltage is
  above the bus; the emulator applies it anyway, so overspeed regeneration is approximate. Supply limit: solved exactly from
  `I_supply = V (V - EMF) / (R V_bus)`; drops to `SupplyCurrentLowerLimit` after
  `SupplyCurrentLowerTime` at the limit. Defaults equal Phoenix's factory defaults (120 A stator,
  70/40 A for 1 s supply).
- Neutral: brake shorts the windings (`StaticBrake`), coast opens them (`CoastOut`); `NeutralOut`
  follows the configured neutral mode.
- Hardware limits (`HardwareLimitSwitchConfigs`): enable, normally open/closed, source (the
  device's pin, RemoteTalonFX, RemoteCANcoder, RemoteCANifier, RemoteCANrange, RemoteCANdi S1/S2,
  Disabled), remote sensor ID and autoset position. An asserted limit, or the request's
  `LimitForwardMotion` / `LimitReverseMotion`, puts the output in neutral (the configured
  brake/coast) while the demanded output pushes that way; output away from it is allowed.
  `IgnoreHardwareLimits` overrides both, `IgnoreSoftwareLimits` the soft limits. Inputs:
  `SetForwardLimitPin` / `SetReverseLimitPin` (switch closed), `SetRemoteLimit(source, id,
  closed)`, or `AttachCanRange(id, &range)` for a `CanRange`, which the Talon reads at each step
  and therefore sees at the CANrange's measurement rate. `FromPhoenix(TalonFXConfiguration)`,
  `FromPhoenix(CANrangeConfiguration)` and `FromApplied` carry all of these over:

  ```cpp
  mayhem::sim::CanRange farRange{mayhem::sim::FromPhoenix(CoralRangeConfigs())};
  coralEmulator.Configure(mayhem::sim::FromPhoenix(coralLeaderConfigs));  // RemoteCANrange, ID 21
  coralEmulator.AttachCanRange(21, &farRange);
  // each 1 ms tick: farRange.SetDistance(distanceToCoral); farRange.Step(dt); then step the Talon
  ```
- FOC: every request carries `enableFoc` (default true) and picks the FOC or trapezoidal curve.
- Motion Magic: WPILib-equivalent trapezoid; Motion Magic Expo is WPILib's exponential profile
  with `MotionMagicExpo_kV/kA`; Motion Magic Velocity ramps at the request's acceleration (or
  the config's). A profile starts from the measured position and velocity when entered from
  another request type and re-plans from its own state on a new target.
- Swerve: ChassisSpeeds discretization, kinematics with heading memory, desaturation to
  `kSpeedAt12Volts`, module optimization, cosine compensation, coupling correction, wheel force
  feedforward, drive Velocity/OpenLoopVoltage and steer Position/MotionMagicExpo outputs in
  voltage or torque-current form, FacingAngle heading PID, Phoenix's steer Expo gains
  (kV = 0.12 x ratio, kA = 1.2 / ratio).

Chosen where Phoenix does not document behaviour (verify against hardware logs if it matters):

- kD uses (reference velocity - measured velocity) in position modes and (reference
  acceleration - measured acceleration) in velocity modes; the integrator resets on a request
  type or slot change and is clamped to the peak output.
- Motion Magic with a jerk limit uses an online jerk-limited approximation, not CTRE's exact
  S-curve. Motion Magic Expo assumes a 12 V maximum input; a cruise velocity caps it by scaling
  that input. Motion Magic with zero cruise velocity or acceleration holds its start.
- The supply-limit lower timer runs while the demanded supply current is at or above the
  regular limit; regenerated current is not supply-limited.
- Arm_Cosine uses the measured position.
- Hardware limits compare the sign of the demanded output (volts or amps, before the stator and
  supply limits); autoset holds the position at its value while the limit is asserted;
  followers apply the leader's output without checking their own limits; an unwired
  normally-closed pin reads asserted, as on the device. CANrange detection is below
  threshold - hysteresis and clears above threshold + hysteresis (Phoenix's documented
  semantics); signal strength and the field of view are not modeled.
- Swerve wheel force feedforward is projected on the optimized target angle; open-loop drive
  adds its feedforward volts; a non-zero update period adds a steer velocity feedforward (target
  change / period, 180-degree flips excluded) to Position steer requests only.

Known gaps: no voltage ramps, differential or DutyCycle closed-loop requests,
no velocity-measurement filtering, CAN latency only through `SampledSignal`, no motor temperature or thermal limits, motor
rotor inertia must be folded into the plant inertia, the terrain is a height field (no
overhangs; tall steps should also be obstacles), the chassis is rigid (no suspension or bumper
compression beyond the penalty springs), and ball spin is not simulated on the ground.

## Monte Carlo runs

`scripts/sim/montecarlo.py` runs N copies of a test executable in parallel and summarizes them:

```sh
python3 scripts/sim/montecarlo.py --cmd "./build/install/simAutoTest --auto Left4" \
  --runs 200 --jobs 8 --out sim-runs --worst-metric autoTime --higher-is-worse --json summary.json
```

Each run gets `MAYHEM_SIM_SEED=<seed>` (seed it with `Rng(Rng::SeedFromEnv())`) and
`MAYHEM_SIM_OUT=<out>/run_<seed>.json`, where it writes
`{"passed": bool, "failure": "why", "metrics": {"name": number}, "log": "path.wpilog"}`. The
summary lists failure modes by frequency, metric percentiles (p5, p50, p95, min, max) and the
worst seeds with their logs to open in AdvantageScope. Exits 1 if any run failed.

## CAD to AdvantageScope

`scripts/sim/cad-to-advantagescope.py` turns a CAD GLB (an Onshape export of a whole robot:
hundreds of MB, millions of vertices, thousands of nodes) into an AdvantageScope custom robot
asset folder:

```sh
uv run scripts/sim/cad-to-advantagescope.py robot.glb robot-asset.json --list   # every instance
uv run scripts/sim/cad-to-advantagescope.py robot.glb robot-asset.json --out assets/
```

The JSON config names the CAD axes for robot forward and up (Onshape exports are often Z-up;
check the preview), the origin (or "auto": the x-y centre of the drivetrain parts, floor at the
lowest point of the `originMatch` parts), regexes of node paths to drop (fasteners, bearings,
spacers), `dropBelowFloor` (drop part instances whose top is below a height, e.g. unmated parts
left at an assembly origin under the robot) and `dropOutside` (a robot-frame box; instances
whose centre is outside it are dropped, except parts of a component, which may extend), and the articulated
components, each with node-path regexes and a joint (`revolute` axis + origin, or `prismatic`
axis). The script's docstring documents every field. `--list` prints every part instance (node index,
robot-frame box centre, z range, whether and why it is dropped), so strays that share a path with
real parts can be found by position. An optional `"clip": {"minZ": m, "maxZ": m}` on a component
(or at the top level for the base model) clamps its vertices to that robot-frame height range,
for parts cut down after the CAD export (e.g. a hopper trimmed to 0.555 m). Output: `Robot_<Name>/config.json`,
`model.glb`, `model_<i>.glb` (flat-shaded, CAD colours kept, robot frame, total size within
`targetMB`, default 15 MB), plus `Robot_<Name>.preview.png` (side and top views coloured by
component, with the origin and joint axes) and `Robot_<Name>.joints.json`. Copy the folder into
AdvantageScope's custom assets folder.

Each component's `zeroedPosition` is minus its joint origin, so robot code logs, in config order,
`Pose3d(origin, Rotation3d(axis * angle))` for a revolute joint and
`Pose3d(origin + axis * distance, Rotation3d())` for a prismatic one. Decimation is uniform
vertex clustering with the cell size bisected to the byte budget (a 232 MB, 5.7M-triangle robot
becomes 13.7 MB in ~18 s); `"quadric": true` adds a quadric pass first, which is sharper on
organic shapes but can fold long thin CAD parts.

## Tests

`lib-cpp/tests/sim_devices_test.cpp`, `sim_swerve_test.cpp` and `sim_pieces_test.cpp` (run by
ctest) check: free speed, free current, stall current and torque of every curve; FOC vs
trapezoidal; velocity, position and all Motion Magic loops converge within their limits;
ArmCosine kG holds an arm; stator and supply (lower-limit) current limits; brake vs coast;
follower directions; battery sag and brownout; hard stops; top speed (5.2 m/s for 68 kg, Kraken
X60 FOC at 5.9:1 on 2 in wheels) and a traction-limited launch; a current-limited launch matching
the closed form (including wheel inertia) within 0.1%; lateral sliding at mu_k g; walls and a
5 cm panel at full speed without tunnelling; trench clearance by robot height; the REBUILT bump
straight at 1, 2 and 4 m/s and at 45 degrees (roll, an unloaded wheel); high-centring a 4.1 cm
belly pan by crawling over the ridge; X-brake holding on a 15-degree ramp (and sliding when mu is
too low); static slope loads vs closed form; Phoenix request math; robot-robot pushing; 20 ms
Steps stay stable; spawning under an overhead trench arm, into a wall or column, into another
robot and on top of game pieces resolves without a launch; drag-free projectile ranges vs closed form, drag and Magnus; bounce and
rolling; 500 balls with a robot plowing through them under a time budget; intake capacity and
goal entry direction; and bit-for-bit determinism. `sim_cylinders_test.cpp` checks coral at rest
(no drift, sleeping), a flat drop's rebound against e^2 h, a standing coral pushed at the top
falling over its base edge and pushed at the base sliding upright, rolling across the axis vs
sliding along it at mu g (closed form), a bumper and an end-effector plate pushing a coral, a
robot spawned on one, a wall and a prism stopping one, resting on and tipping off a box,
stacking, the intake query and hold/release, a spinning roller driving a coral, 20 coral under a
time budget, and determinism. `sim_sensors_test.cpp` checks the camera's projection, each
detection limit, occlusion by a prism and another robot (and not by the tag's own mount), motion
blur against fx w t_exp, frame rate and latency, error growing with distance and smaller for
non-coplanar tags, single-tag ambiguity and mirrored solutions frontal vs oblique, determinism,
SampledSignal timing, and the gyro's scale error, bias, saturation and seeded random walk.
