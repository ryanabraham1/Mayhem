# 3256-Tools companion changes

The live website is [3256 Tools robot logs](https://www.warriorb.org/logs). Source and review history are in [PR #2](https://github.com/ryanabraham1/3256-Tools/pull/2), including actual hosted AdvantageScope Lite, selected-log handoff, private cloud storage and uploads from Mayhem.

`robot-log-library.patch` preserves the complete source difference independently of the temporary implementation checkout. On a clean checkout of the previous 3256-Tools main, use `git apply /absolute/path/to/robot-log-library.patch`. Prefer the repository source; do not apply the patch over changes already included there. Unified-diff context lines intentionally contain a space.

The patch includes application source, the private-storage migration, tests and setup/provenance documentation. It contains no credentials. The production migration, native desktop upload, authenticated playback and actual AdvantageScope graphs were verified with a labeled synthetic recording. Physical robot collection remains unverified.
