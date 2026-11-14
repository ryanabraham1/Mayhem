# Changes

Changes shows what a code change does to the robot, read straight from the code, so you can review agent-written (or anyone's) code by behavior instead of by diff.

## Pick what to compare

In the desktop app, click **Choose robot code folder** and pick the robot repository. Then choose **Before** and **After**:

- **This computer (not committed)**: your working copy, with how many files are edited.
- **Last commit** on the current branch.
- Any branch, branch on GitHub, tag or recent commit.

**Reload** re-reads the code. In the browser, use **Open review file** with a file made by:

```sh
node scripts/mayhem.mjs review <robot repo> [before] [after] --json > review.json
```

The chip next to the tabs gives the overall risk. Red means a safety change.

## Summary

- **Why.** The tasks these commits were for (agents add a `Mayhem-Task: <id>` line to their commits), so you see the request next to the result.
- **Area cards.** Driver controls, state machines, values, hardware, autos and generated robot code, each colored by its riskiest change. Click one to open its tab.
- **Findings.** Every change, marked **safety**, **review** or **ok**. Use the thumbs to send **Looks good** or **Not right** straight to [Tasks](/suite/tasks).

## Tabs

| Tab | What it shows |
| --- | --- |
| **Controls** | Each driver input and what it does, before and after. Team rule: the same inputs must give the same outcomes, so any change here is called out. Comes from machines that list `operator` inputs in `tools/mayhem/machines.json`. |
| **State machines** | Added, removed and changed states and transitions. |
| **Values** | Changed constants: limits, gains, ratios. Safety kinds are marked red. |
| **Hardware** | A top-view map of the robot's devices with changed ones highlighted, and a table of CAN IDs and motor configuration. |
| **Autos** | Before/after paths, colored by speed, with time and distance differences. |
| **Sim proof** | Runs the robot code in simulation, before and after. See below. |

### Editing values and hardware

With **After** set to **This computer**, click the pencil on a value or device field to change it. Only that literal in the C++ source changes. The edit shows up as a change right away.

## Sim proof

**Run sim proof** builds both versions and runs every auto, presses every driver button, and runs your team scenarios from `tools/mayhem/scenarios.json`. The first run takes about a minute per version; repeats are cached.

Results are grouped into **Autos**, **Buttons** and **Team scenarios**, each marked pass, fail or different. Open one to replay it:

- **Field** or **3D** view (3D uses the team's CAD robot), **Side by side** or **Overlay**.
- Button results show lanes: shaded where the button is down, gray when idle.
- Click a spot on the replay, or **Comment here**, to pin feedback to that place and moment.
- **Record clip** makes a video you can download. It's kept only while the replay is open.

A team scenario looks like:

```json
{
  "scenarios": [
    {
      "name": "Hold A shoots",
      "steps": ["teleop", "wait 0.5", "hold A 2"],
      "expect": ["Shooter mode is SHOOTING by 1.5 s"]
    }
  ]
}
```

If the sim proof says the generated code is out of date, run `tools/mayhem/export.sh` in the robot repo.
