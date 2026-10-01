# Projects and deploying

A project is a folder containing `project.mayhem` (robot, field, named commands, pose variables) and one `<path name>.mtraj` file per path.

## Put it in your robot code

The easiest setup is to create the project **inside your robot code** at `src/main/deploy/mayhem/`. Every save is then already "deployed": WPILib copies the `deploy` folder to the roboRIO on the next code deploy, and MayhemLib reads `deploy/mayhem/<name>.mtraj` there.

If you keep the project somewhere else, set **Settings → Project → Deploy folder**. Generated paths are copied there automatically whenever they are saved. A brief success banner confirms each path save.

::: tip
The roboRIO file system is case sensitive. The path name in your robot code must match the file name's case exactly.
:::

## New projects

New projects start with the 2026 REBUILT field. Click **New project** on the welcome screen and pick a folder, or **Open project** to open an existing one. The welcome screen lists recent projects.

## What gets saved

| File | Contents |
|---|---|
| `project.mayhem` | Robot, field and obstacles, pose variables, fuel sim robots and settings |
| `<Name>.mtraj` | One path: its waypoints, constraints and markers (the *inputs*), and the solved trajectory (the *output*) |

A path is marked **out of date** when its inputs change after it was generated. Regenerate it before you deploy.
