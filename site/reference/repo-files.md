# The tools/mayhem folder

Everything Mayhem keeps in a robot repo. All of it is plain text, meant to be committed and reviewed like code.

| Path | Written by | Contents |
| --- | --- | --- |
| `robot.mayhem.json` | The app, agents | The project: robot limits, typed inputs, routines, machines and log rules. `mayhem-suite` format, version 1. |
| `src/main/include/MayhemProject.h` | `cpp` / `export.sh` | Generated C++. Don't edit; regenerate. |
| `src/main/include/mayhem/` | `vendor` | Vendored C++ headers, if you vendor instead of using the vendordep. |
| `tools/mayhem/machines.json` | People, agents | [Machine specs](/robot-code/state-machines). Source of the driver-controls review. |
| `tools/mayhem/scenarios.json` | People, agents | [Sim proof scenarios](/robot-code/scenarios). |
| `tools/mayhem/explainer.json` | The app | Plain-language part descriptions for **Overview → How the robot works**. |
| `tools/mayhem/export.sh` | You | Regenerates `MayhemProject.h`; `--check` for CI. |
| `src/main/deploy/mayhem-build.json` | Your build | The [build stamp](/robot-code/logging#what-s-deployed). Git-ignored. |

## The project file

Projects are versioned JSON (`"format": "mayhem-suite", "version": 1`). Unknown data under `extensions` is kept as-is, so tools can add their own. Every save increments `revision`; see [saving projects safely](/agents/tools#saving-projects-safely).

The full schema is `app/src/suite/core/model.ts` in the Mayhem repository.
