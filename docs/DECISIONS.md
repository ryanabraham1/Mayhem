# Decisions

Standing product and engineering decisions for Mayhem. Check here before changing scope, UI direction or file formats; these were settled with the team and shouldn't be re-litigated without a reason.

## What Mayhem is

- The place where people review a robot whose code is written by coding agents. People tell the agent what they want in the agent's own chat; the agent changes the code on a branch; people review that branch in Mayhem by what the robot does, not by reading the diff.
- No work tracking inside the app: no task queue, plan approval, driver form, pit notes, "make this an agent task" buttons or in-app agent launcher. The Tasks page was removed on purpose after v0.9.45.
- The unit of review is a git branch. `main` is the known-good version; there are no separate known-good marks.
- Evidence people see is recorded by the tool or app that produced it (behavior review read from code, sim proof stored as a git note on the commit), never typed by an agent. Risk labels come from the diff, not from agent claims.
- No named-person sign-off. Safety changes are marked red; nothing gates on a signature.
- People may edit plain values (CAN IDs, current limits, brake/coast, directions, ratios) in the app; only that literal is rewritten in the working copy.

## Scope and targets

- **Season:** 2026, game REBUILT, WPILib 2026 on roboRIO 2. SystemCore / WPILib 2027 comes later; nothing may depend on 2027.
- **Robot code:** C++ (the team's robot), with the header-only MayhemCpp library in `lib-cpp/`. The Java MayhemLib and the Python trajectory solver were removed after v0.9.59.
- **Platforms:** macOS, Windows (x64, NSIS installer) and Linux.

## Autos

- Pose-to-pose goals with a measured-arrival controller (ported from BLine-Lib; see THIRD_PARTY_NOTICES.md), not time-parameterized trajectories.
- The browser preview uses the BLine-Web-derived engine; see [PATH_PREVIEW_PARITY.md](PATH_PREVIEW_PARITY.md).
- Agents may write arbitrary C++ and custom action callbacks; the visual model documents behavior, it does not limit what robot code can do.

## Robot logs

- Log analysis (`app/src/suite/core/{analysis,wpilog,plot}.ts`) is shared with the team site's `/logs` page; see the repo's CLAUDE.md for the sync rule.
- Original log files are kept unchanged; analysis reads them.

## Desktop app UI

- Suite navigation is a top bar, not a permanent sidebar.
- **Theme:** mostly white with a purple accent, card-based; light is the default and dark is opt-in.
- No walls of raw text, huge red banners or glossary-style hand-holding; prefer visuals (lanes, cards, spec-sheet rows) and small chips.
- **No "AI landing page" look:** no big hero headlines, eyebrow labels or stat cards.

## Distribution

- The repo is public (github.com/ryanabraham1/Mayhem). Pushing a `v*` tag builds and publishes a release via GitHub Actions; while Actions is unavailable, releases are built locally (see [BUILDING.md](BUILDING.md)).
- The app updates itself from GitHub Releases but installs only when the user clicks (v0.6.0). The updater signing key must stay backed up; see [BUILDING.md](BUILDING.md).
- MayhemCpp is a hosted vendordep on GitHub Pages (`gh-pages`). Hosted versions are immutable; bump the version to ship library changes.
- Every release's notes start with a "New in vX" changelog.
