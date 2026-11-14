# A week with Mayhem

Each workspace is useful alone, but they're built to work as a loop: drive the robot, collect logs, say what's wrong, let an agent (or a person) fix it, review the change by what it does, and deploy. This page follows that loop.

## Before the robot drives

- **Pick the robot code folder** once, on any page. Changes, Tasks, Robot and the Overview explainer all read it.
- **Turn on log collection** in **Robot → Log collection**. Mayhem pulls new `.wpilog` files off the roboRIO whenever the laptop is on the robot network. See [Log collection](/suite/robot#log-collection).
- **Connect** with your team number in **Robot → Connection** to see live state machines and the robot's current state. Mayhem only reads NetworkTables; it never commands the robot.
- Work through **Overview → Get to match-ready**. Each item has a button that takes you to the fix.

## After a practice match

1. The log arrives in **[Logs](/suite/logs)** and is checked right away: brownouts, battery sag, loop overruns, disconnects and flickering signals.
2. **Robot → On the robot now** shows which commit is running, whether it was deployed with uncommitted changes, and how it differs from `main`.
3. If something looked wrong, click its moment in the log and **Comment here**, or fill in the **Driver form** on Tasks. That feedback becomes a task pinned to that log and time.

## Fixing it

![The Tasks board](/img/suite/tasks.jpg)

On **[Tasks](/suite/tasks)**, feedback moves across a board:

1. **New:** waiting for an agent (or a teammate).
2. **Plan to approve:** the agent explains, in plain English, what it'll change and how you'll see it. Approve it, or say what should be different.
3. **Ready to check:** the change is done. Open it in Changes.

You can skip agents entirely; the board works as a shared to-do list for the programming team too.

## Reviewing the change

![The Changes summary](/img/suite/changes.jpg)

**[Changes](/suite/changes)** compares two versions of the robot code by behavior: driver controls, state machines, values, hardware and autos. A red chip means a safety change, such as a CAN ID, current limit, motor direction or gear ratio. Run the **sim proof** to build both versions, press every button, run every auto and your team's scenarios, and replay any difference.

Accept the change, or send it back with a note saying what's wrong.

## At competition

- Keep `main` as the known-good version. If the robot is running something else and it misbehaves, **Robot → On the robot now → Put main back on the robot** builds and deploys `main` (robot connected and disabled).
- Use pit notes for anything quick: "left intake roller rubbing the frame".
- Upload logs to the team site from **Robot → Log collection → Team upload** so the whole team can open them.
