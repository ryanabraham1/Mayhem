# Robot logs must stay in sync with 3256-Tools

The Logs page here and the team site's `/logs` page (github.com/ryanabraham1/3256-Tools, `components/robot-logs/viewer.tsx`) are meant to behave identically: same analysis, same current-draw filtering, same signal-mapping editor, same "estimated" labels.

- Analysis code (`app/src/suite/core/{analysis,wpilog,plot}.ts`) is the source of truth. After changing it, run `node scripts/sync-team-log-core.mjs <path to 3256-Tools>` and commit/deploy 3256-Tools. Never edit the copies in `lib/robot-logs/core/` there.
- The UI is NOT shared code. If you change the signal-mapping editor, current-draw list, estimated-current labels, or saved-mapping behavior in `app/src/suite/logs/LogsPage.tsx` or `app/src/suite/logLibrary.tsx`, make the same change in 3256-Tools' `components/robot-logs/viewer.tsx` (and the reverse). Saved mappings use the localStorage key `robot-log-mapping:<log id>` in both.
- Add or update tests in both repos when behavior changes.
