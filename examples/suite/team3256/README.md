# Team 3256 offseason robot in Mayhem

`../team3256-offseason-2026.mayhem.json` models [Team3256/FRC_Offseason_2026](https://github.com/Team3256/FRC_Offseason_2026), branch `claude/friendly-tesla-o02ue3` (the C++ port), commit `d55489f`.

- **Routines:** the five Mayhem chooser autos. The robot's paths are old time-optimal `.mtraj` trajectories; `build_project.py` converts their waypoints into pose-to-pose goals (stopping waypoints settle, the rest hand off while moving, the last one aims at the hub). Path markers become `Superstructure → STATE` steps exactly as `MayhemAutos.cpp` binds them, including names a path does not contain.
- **Superstructure machine:** every state and transition in `Superstructure.cpp`, with driver buttons and the alliance zone as inputs. Its state channel is `/RealOutputs/Superstructure/State`, so robot logs replay on the graph.
- **Log rules:** battery under 11.5 V for 2 s, and brownouts, on the `/RealOutputs/SystemStats/*` channels.

Regenerate after the robot code changes:

```sh
python3 build_project.py /path/to/FRC_Offseason_2026 ../team3256-offseason-2026.mayhem.json
```

## Simulated match logs

`MatchLogTest.cpp` runs a practice match (the selected auto, then teleop: intake, drive into the zone, shoot, jitter, outtake, home) through the robot's own `RobotHarness` with WPILib data logging on. Copy it into the robot's `src/test/cpp/`, then:

```sh
export JAVA_HOME=~/wpilib/2026/jdk
./gradlew installFrcUserProgramTestOsxuniversalReleaseGoogleTestExe --offline
for t in OutpostTrenchSweep OutpostTrenchSweepX2 DepotTrenchSweep DepotTrenchSweepX2 DepotTrenchSweepDepot; do
  ROBOT_LOG_DIR=$PWD/simlogs/$t build/install/frcUserProgramTest/osxuniversal/release/frcUserProgramTest --gtest_filter="MatchLog.$t"
done
```

Each match takes about 46 s of real time (Phoenix simulation runs on the wall clock). Point Mayhem's **Robot → Automatic log collection → Folder** at `simlogs` to collect and analyze them, or import them in **Logs**.

## What the simulation found (2026-11-11)

- **Outpost Trench Sweep x2** and **Depot Trench Sweep x2** never intake during their second sweep. Part 2 binds `AtTime("intake2")`, but `OutpostTrenchSweepBumpPt2.mtraj` names its marker `intake` and `DepotTrenchSweepBump2xPt2.mtraj` has no intake marker at all. MayhemLib's `AtTime(name)` silently never fires for a missing name. Recorded states: `SHOOT` from 8.25 s to 16.25 s with no `INTAKE`. Outpost part 2's `idle2` binding is missing too, and Depot Trench Sweep Depot part 1 binds `idle`, which its path doesn't have.
- **Driving into the alliance zone while shooting drops to REV and stops feeding.** The zone trigger sets `REV` on its rising edge from any state, so `SHOOT_AND_INTAKE → REV` appears in every match.
- In simulation the battery sagged to about 8.1 V during a full-speed teleop sprint. Drive motor currents are not logged, so the per-mechanism current ranking can't attribute drivetrain load.
