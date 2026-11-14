# Projects, files and settings

## Projects

Click the **project name** in the top bar to create, rename, duplicate, open or switch projects. Each project holds its robot limits, routines, typed inputs and state-machine manifests. **Export project** (in the same menu) downloads a portable JSON backup; the upload button next to the name imports one.

Projects use the `mayhem-suite` version 1 JSON format. In a robot repo the project is `robot.mayhem.json` at the root; choosing that folder opens it. See [the tools/mayhem folder](/reference/repo-files).

### Live file link (desktop)

**Tasks → Connect an agent → Save project file** writes the project into your robot repository and keeps it linked:

- App edits save back to the file.
- Edits made outside the app (by you or an agent) reload automatically, with a revision check.
- If a conflict banner appears, export your current work, then reopen the file and reconcile.

In the browser, **Download project file** saves a one-time snapshot instead.

## Settings

Open with the gear in the top bar.

| Panel | What's there |
| --- | --- |
| **Appearance** | Light, Dark or Match system. The sun/moon button in the top bar toggles it too. |
| **Keyboard shortcuts** | The full list (also `?` in Autonomous). |
| **Updates** | Version and update check. A banner appears when a release is out; **Install** restarts into it. |
| **Recovery** | **Export recovery snapshot** downloads the last saved copy if a project was ever damaged. |
