# Installation

Mayhem has two things to install: the **desktop app** on your laptop and the **MayhemLib vendordep** in your robot project.

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

From 0.6.0 on, Mayhem updates itself. It shows a banner when a new release is out and installs the update when you click **Install & restart**. You can also check in **Settings → About & updates**.

## MayhemLib (robot code)

MayhemLib is hosted as a normal vendordep, so you install it the same way as Phoenix 6 or PathPlanner. In VS Code with the WPILib extension, open the command palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>), run **WPILib: Manage Vendor Libraries**, choose **Install new libraries (online)**, and paste:

```
https://ryanabraham1.github.io/Mayhem/MayhemLib.json
```

Offline installs, installing from a checkout, and the other vendordeps you'll need are covered in [MayhemLib installation](/lib/installation).

## Running from source

To work on Mayhem itself, see [Building and contributing](/reference/building).
