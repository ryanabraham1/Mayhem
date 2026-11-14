# Sim proof scenarios

The **sim proof** on the [Changes](/suite/changes#sim-proof) page builds two versions of your robot code and runs both in simulation:

- every controller button, tapped and held for 2 s in teleop,
- every routine in `robot.mayhem.json`, as a 20 s auto on the full field,
- your team's scenarios from `tools/mayhem/scenarios.json`.

Then it compares what the robot did. The first two come for free. The third is your regression suite: add a scenario for every behavior a driver relies on.

## Writing a scenario

```json
{
  "scenarios": [
    {
      "name": "Hold A shoots",
      "steps": ["teleop", "wait 0.5", "hold A 2", "wait 0.5"],
      "expect": ["Shooter mode is SHOOTING by 0.7 s", "Shooter mode is REV at 3 s"]
    },
    {
      "name": "X starts intaking, X again stows",
      "steps": ["teleop", "wait 0.5", "press X", "wait 1", "press X", "wait 1"],
      "expect": ["Intake mode is INTAKING by 0.7 s", "Intake mode is STOWED at 2.5 s"]
    }
  ]
}
```

### Steps

| Step | Does |
| --- | --- |
| `teleop`, `auto`, `disabled` | Switch mode. |
| `select auto <name>` | Pick the auto to run. |
| `wait <s>` | Let time pass. |
| `press <button>` | Tap a button. |
| `hold <button> <s>` | Hold a button for that long. |
| `down <button>`, `up <button>` | Press or release, for combinations. |
| `stick left\|right <x> <y>` | Move a stick (forward is +y). |

Buttons: `A B X Y LB RB LT RT Back Start LS RS Up Down Left Right`.

### Expectations

| Expectation | Passes when |
| --- | --- |
| `<machine> is <STATE> by <t> s` | It got there by then. |
| `<machine> is <STATE> at <t> s` | It's in that state at that time. |
| `<machine> reaches <STATE>` | It gets there at some point. |
| `<machine> never <STATE>` | It never enters that state. |
| `auto completes` | The routine finishes. |
| `no tip-over`, `no collisions` | Nothing went wrong physically. |
| `battery stays above <v> V` | The simulated battery holds up. |

Machines and states can be written by name or ID; times are seconds from the start of the scenario. A machine that flips back and forth (6 or more changes 0.1 s apart) always fails.

## Running it

- **In the app:** Changes → **Sim proof** → **Run sim proof**. The first run takes about a minute per version; repeats are cached. Open any result to replay it on the field or in 3D, side by side or overlaid.
- **From the command line:** `node scripts/mayhem.mjs sim <robot repo> [after] --before <rev>`.

The Changes page also reviews the scenarios file itself: removing a scenario, or loosening one, is a finding. Adding them never is.

## What it needs from your robot

The sim proof runs your robot code through the robot's own simulation test harness (`RobotHarness`), one process per scenario, and records a `.wpilog` for each. Outcomes are compared on every machine's state channel, the drive mode, the auto status and the simulated pose.

Builds are cached per commit. **This computer** (uncommitted changes) rebuilds incrementally, in about 45 s. If it reports the generated code out of date, run `tools/mayhem/export.sh` first.
