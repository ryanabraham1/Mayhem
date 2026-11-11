# 3256-Tools companion changes

The website log library is available as [draft PR #2](https://github.com/ryanabraham1/3256-Tools/pull/2) on branch `codex/robot-log-library`, commit `f7238e2`.

`robot-log-library.patch` preserves the complete change independently of the temporary implementation checkout. On a clean checkout of 3256-Tools without these changes, `git am /absolute/path/to/robot-log-library.patch` can recreate the commit. Prefer the PR branch when available. Do not apply the patch on top of an existing copy.

The patch contains application source, the private-storage/database migration, tests, field asset, and `docs/ROBOT_LOGS.md` with production setup instructions. It contains no credentials. The production migration and upload round trip remain outstanding.
