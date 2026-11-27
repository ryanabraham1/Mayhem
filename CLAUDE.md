# Robot logs must stay in sync with 3256-Tools

The Logs page here and the team site's `/logs` page (github.com/ryanabraham1/3256-Tools, `components/robot-logs/viewer.tsx`) are meant to behave identically: same analysis, same current-draw filtering, same signal-mapping editor, same "estimated" labels.

- Analysis code (`app/src/suite/core/{analysis,wpilog,plot}.ts`) is the source of truth. After changing it, run `node scripts/sync-team-log-core.mjs <path to 3256-Tools>` and commit/deploy 3256-Tools. Never edit the copies in `lib/robot-logs/core/` there.
- The UI is NOT shared code. If you change the signal-mapping editor, current-draw list, estimated-current labels, or saved-mapping behavior in `app/src/suite/logs/LogsPage.tsx` or `app/src/suite/logLibrary.tsx`, make the same change in 3256-Tools' `components/robot-logs/viewer.tsx` (and the reverse). Saved mappings use the localStorage key `robot-log-mapping:<log id>` in both.
- Add or update tests in both repos when behavior changes.

# Check your own work before the user does

The user tests what you hand over; find the problems first. For any change to the app:

1. Use it yourself: `node scripts/app.mjs start`, then `go <page>`, `click`, `fill`, `see` (what's on screen) and `screenshot` (read the PNG). `node scripts/app.mjs help` lists every command. It runs your edited code live, with the desktop backend faked by `scripts/desktop-bridge.mjs` (real files and git; fake robot, team site and GitHub, so nothing real is touched). Show the user the screenshot of what you built.
2. Prove it with a browser test in `app/e2e/` (use the names `see` printed) and add or update the feature's row in `app/e2e/features.ts`.
3. Run `pnpm check` in `app/` (lint, typecheck, unit tests, build, every browser test). It must pass. If you touched `app/src-tauri`, also run `cargo test` there; a new desktop command needs a fake in `scripts/desktop-bridge.mjs`.

When the user corrects how you write code here, add a rule to `scripts/lint.mjs` (with a message that names the root fix) and fix existing violations, instead of adding a line to this file.
