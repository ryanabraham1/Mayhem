# Conventions

These apply to the project file, the generated C++ and the app. Getting one wrong usually shows up as a robot that drives mirrored or to the wrong place.

- **Field frame.** WPILib blue origin. +x points from the blue wall toward the red wall, +y points left from the blue driver station, headings are counterclockwise-positive. Robot code must report the blue-origin pose **on both alliances**, which is what CTRE's `getState().Pose` returns.
- **Units.** Meters, seconds, and radians in files and C++. The app shows degrees for headings and turn rates, and converts.
- **Speeds.** The runner and pose controller output **field-relative** m/s and rad/s. Convert if your drivetrain wants robot-relative speeds.
- **Robot front.** +x of the robot, which is the intake on most robots. **Motion** heading faces the direction of travel.
- **Alliance.** Routines are authored on blue and transformed at autonomous init with `AllianceRoutine::Apply`. See [Red alliance](/robot-code/autos#red-alliance). Never transform measured odometry.
- **IDs.** Action, signal and event IDs are free-form strings (`intake.acquire`). The same string must appear in the app and in a `Bind` / `BindSignal` call.
- **Priority.** Transitions are checked in the order they're written; the first true one wins.
- **Timeouts.** A watchdog timeout is a failure, never proof that something succeeded, unless the step is marked **Done when time runs out**.
- **`main`.** The known-good version of the robot code. "On the robot now" compares against it, and rollback deploys it.
