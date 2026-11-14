# Team website log sharing

The companion implementation targets [3256-Tools](https://github.com/ryanabraham1/3256-Tools). It adds `/logs`, a team library, browser WPILOG import/playback, up to four plotted signals, field replay, power findings, and private upload/download routes. Mayhem desktop uploads to that API using its persistent retry queue.

Review the implementation in [PR #2](https://github.com/ryanabraham1/3256-Tools/pull/2), branch `codex/robot-log-library`. A standalone patch is also preserved at `integrations/3256-tools/robot-log-library.patch`; do not apply it again if that branch is already checked out or merged.

Deployment requires the robot-log migration in that repository, the existing team authentication/service-role setup, and an optional `ROBOT_LOG_UPLOAD_TOKEN` for desktop uploads. The token is upload-only; team sign-in remains required for viewing files. Originals are stored in a private bucket. The browser uses short-lived signed downloads and verifies the file hash before parsing. The migration, private bucket, and upload token are configured in production. Native desktop upload, signed-in team download/playback, and upload-only token restrictions were verified with a labeled synthetic recording.

Production runs at https://www.warriorb.org/logs. Setup used the actual team's project through the authenticated CLI. Full setup and validation instructions live in the companion repository's `docs/ROBOT_LOGS.md`.

The shared parser, graph decimation, and analysis sources can be synchronized from here:

```sh
node scripts/sync-team-log-core.mjs /path/to/3256-Tools
```

In Mayhem desktop, list robot logs and select the recordings to download. Enable syncing only when desired. Optionally include future logs with an explicit nonempty filename filter. Enable automatic upload to queue new downloads, or use an individual log's cloud button. A queued upload survives restarts; the upload token stays in memory and must be entered again. Each local log has an AdvantageScope button that detects the installed desktop application (including WPILib’s bundle). After upload it also has team-view and hosted AdvantageScope links. The website hosts actual AdvantageScope Lite, currently an upstream preview; it is not a reimplementation.

Browser import/playback works locally without cloud setup. Desktop log collection still needs testing against an actual roboRIO over Ethernet. File limits and unimplemented parts are listed in `SUITE_STATUS.md`.
