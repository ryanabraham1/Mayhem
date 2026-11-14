# Installation

You need the desktop app on the laptops your team uses, and the C++ library in your robot code. Node is only needed if you run Mayhem's command-line tools or connect an agent.

## Desktop app

Get the latest installer from [GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases/latest):

| System | File to download |
|---|---|
| macOS, Apple Silicon | `Mayhem_*_aarch64.dmg` |
| macOS, Intel | `Mayhem_*_x64.dmg` |
| Windows 10/11 (x64) | `Mayhem_*_x64-setup.exe` |
| Linux | `.AppImage` (portable) or `.deb` (Ubuntu/Debian) |

### macOS

Open the `.dmg` and drag Mayhem into Applications. These builds are not notarized, so if macOS blocks the first launch, run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Mayhem.app
```

### Windows

Run the setup program. It installs for your user only, without an admin prompt. The installer is not code-signed, so if SmartScreen stops it, click **More info**, then **Run anyway**.

### Linux

Make the `.AppImage` executable and run it, or install the `.deb`.

### Updates

Mayhem updates itself. A banner appears when a new release is out; click **Install & restart**. You can also check in **Settings → Updates**.

## C++ library (robot code)

Your robot runs Mayhem routines and state machines with the header-only **MayhemCpp** library. In VS Code with the WPILib extension, open the command palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>), run **WPILib: Manage Vendor Libraries**, choose **Install new libraries (online)**, and paste:

```
https://ryanabraham1.github.io/Mayhem/MayhemCpp.json
```

Offline installs and copying the headers into the repo instead are covered in [Set up a robot repo](/robot-code/setup).

## Command-line tools (optional)

Exporting C++, checking generated code in CI and connecting agents use `scripts/mayhem.mjs`. It needs **Node 24 or later** and no `npm install`. Download `Mayhem-suite-tools-<version>.zip` from the same release, extract the whole folder, and run:

```sh
node Mayhem-suite-tools-<version>/scripts/mayhem.mjs --help
```

A Mayhem source checkout works the same way. See [Command line and MCP tools](/agents/tools).

## Browser version

Most of the editing works in a browser from a source checkout (`cd app && pnpm install && pnpm dev`, then open `http://localhost:5173`). Reading robot code, log collection, live file links and deploys need the desktop app; see [Desktop vs. browser](/suite/overview#desktop-vs-browser).
