# Markers and pose variables

## Event markers

Click **+** next to *Event markers* in the sidebar. A marker is a name plus a command bound in robot code, placed at a waypoint with a time offset. A **zone marker** stays active until its end point.

- **If bump recovery skips it:** fire when rejoining (the default), fire immediately, or skip.
- **Must hit:** recovery can never jump past this marker's time.

Marker ticks show in amber on the timeline. In robot code they run bound commands or trigger `atTime(...)`. See [Event markers](/lib/markers).

## Pose variables

Pose variables are named poses shared by every path in the project, for example a shooting spot or an intake station.

- **Create one.** Open **Pose variables** beside the Constraint button, then click **New pose variable**. If a waypoint is selected, the new variable starts at its pose and links to it. You can also click **Save as** in the waypoint panel.
- **Link a waypoint.** Use the waypoint panel's *Pose variable* menu. Linked waypoints show a ring.
- **Move one.** Moving a linked waypoint, or editing the variable, moves it in **every** path that uses it. Those paths are marked out of date.

## Folders

Organize paths with the folder button in the *Paths* header, and drag paths into folders.
