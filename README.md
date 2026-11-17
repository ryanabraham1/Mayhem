# Mayhem

The place where people review a robot whose code is written by coding agents. You tell the agent what you want in its chat; it changes the code on a branch; you review the branch here by what the robot does, not by reading the diff. Around that: pose-based autonomous tools, state-machine inspection, and robot log playback/analysis.

The new suite is in active development. This checkout contains the overhaul; check the assets and notes of a published release before assuming it includes the suite.

## New suite (development)

- **Overview:** the branches waiting for your review, every routine as a field thumbnail, the latest logs with their red flags, and setup checks.
- **Changes:** every branch that isn't in `main` yet, and what each one does, read from the code instead of the diff: driver controls, state machines, values, hardware, autos, any other code that changed. Each shows the sim proof recorded on its newest commit (both versions run in the robot's own simulation), and after the merge whether it is on the robot and in a log.
- **Autonomous:** pose-to-pose routines on the REBUILT field: click to place, drag goals and the start, heading knobs, moving handoffs, robot actions between steps, per-step limits, and a preview with a driven-path trail. Inspector edits arrival, heading policy, watchdogs, concurrent callbacks and branches.
- **State machines:** a layered graph of autonomous routines or any robot state machine. Simulate by toggling inputs (the machine steps through its transitions), watch it live over NetworkTables, or replay a recorded log. "From any state" bindings collapse into chips so large superstructures stay readable.
- **Logs:** a library of recordings with red-flag badges, a verdict and finding timeline per log, Health / Power / Signals / Field tabs, per-mechanism current ranking, and battery sag against the brownout line.
- **Robot:** what code is on the robot now and how it differs from `main`, every value in the code (editable), team number, live connection, automatic log collection from the robot over Ethernet or from a folder (simulation output, USB sticks), team upload with retry, drive limits and robot inputs. Collection runs on every screen, not just Logs.
- **Agents** (in Settings): a short instruction that makes any coding agent's work arrive ready to review, a plain-text project brief, MCP and CLI setup, a live file link agents edit, C++ export, and the raw project document.
- **Team sharing:** companion 3256-Tools web library/viewer source, private cloud uploads, and deployment instructions. Live at https://www.warriorb.org/logs, with actual hosted AdvantageScope Lite and selected-log handoff.

```sh
cd app
pnpm install
pnpm dev
```

Open http://localhost:5173. The browser suite needs no Python solver. For desktop builds, see [docs/BUILDING.md](docs/BUILDING.md).

Start with the [suite user guide](docs/USER_GUIDE.md) for project switching, autonomous previews, state inspection, and log collection. Suite projects use `.mayhem.json`.

Read [suite status and remaining work](docs/SUITE_STATUS.md), [agent/tool usage](docs/SUITE_AGENTS.md), [C++ integration](lib-cpp/README.md), and [team log setup](docs/TEAM_LOGS.md). Physical robot tests and production cloud verification remain outstanding.

## Documentation

**Documentation: <https://ryanabraham1.github.io/Mayhem/>**

## Published desktop downloads

Get the latest installer from [GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases/latest):

| System | File to download |
|---|---|
| macOS Apple Silicon | `Mayhem_*_aarch64.dmg` |
| macOS Intel | `Mayhem_*_x64.dmg` |
| Windows 10/11 (x64) | `Mayhem_*_x64-setup.exe` |
| Linux | `.AppImage` (portable) or `.deb` (Ubuntu/Debian) |

On macOS, drag Mayhem into Applications. These builds are not notarized, so if macOS blocks
the first launch, run `xattr -dr com.apple.quarantine /Applications/Mayhem.app` in Terminal.
On Windows, run the setup program; it installs for your user only, without an admin prompt.
The installer is not code-signed, so if SmartScreen stops it, click **More info**, then **Run anyway**.
From 0.6.0 on, Mayhem updates itself. It shows a banner when a new release is out and installs
the update when you click **Install & restart**.

| Part | Where | Docs |
|---|---|---|
| App (Tauri 2 + React) | [app/](app/) | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Suite C++ controller | [lib-cpp/](lib-cpp/) | [lib-cpp/README.md](lib-cpp/README.md) |
| Building and releasing | | [docs/BUILDING.md](docs/BUILDING.md) |

## Tests

```bash
cd solver && uv run pytest -q
```

```bash
cd lib && ./gradlew test
```

```bash
cd app && pnpm test
```
