# Command line and MCP tools

`scripts/mayhem.mjs` is one entry point for people, CI and agents. Run it from a Mayhem checkout or from the extracted `Mayhem-suite-tools-<version>` release folder (keep the whole folder; copying just the script isn't enough). It needs Node 24 or later and no `npm install`.

## Commands

| Command | Does |
| --- | --- |
| `example` | Print an example project. |
| `inspect <project>` | Summarize a project. |
| `validate <project>` | Check a project; exit 1 on errors. |
| `simulate <project> '<options>'` | Run a routine like the preview does and print the trace. |
| `cpp <project> --out <header>` | Generate `MayhemProject.h`. `--check <header>` exits 1 when it's stale. |
| `vendor <robot dir> [--snapshot <file>] [--check]` | Copy the C++ headers into a robot repo. |
| `machine apply <project> <spec>` | Turn [machine specs](/robot-code/state-machines) into project machines. `machine spec <project> <id>` prints one back. |
| `review <robot repo> [before] [after] [--json]` | The [Changes](/suite/changes) review from the command line. |
| `sim <robot repo> [after] [--before <rev>]` | Run the [sim proof](/robot-code/scenarios). |
| `analyze <log>` | Log findings and power summary. |
| `live <robot address> '<options>'` | Read NetworkTables values from a robot. |
| `open <project>` | Open a project in the desktop app, linked to the file (macOS). |
| `save <project> '<JSON>'` | Write a project atomically, with a revision check. |
| `tool <name> '<JSON>'` | Call any MCP tool below. |
| `mcp` | Run the MCP server on stdio. |

Examples:

```sh
node scripts/mayhem.mjs validate robot.mayhem.json
node scripts/mayhem.mjs simulate robot.mayhem.json '{"mode":"path"}'
node scripts/mayhem.mjs cpp robot.mayhem.json --check src/main/include/MayhemProject.h
node scripts/mayhem.mjs review ../robot main WORKTREE
node scripts/mayhem.mjs analyze logs/FRC_20261113_071603.wpilog
```

## MCP tools

| Area | Tools |
| --- | --- |
| Projects | `inspect_project`, `validate_project`, `save_project`, `simulate_auto`, `open_in_app` |
| Robot code | `export_cpp`, `vendor_cpp`, `apply_machine_spec`, `machine_spec` |
| Review | `behavior_diff`, `run_scenarios`, `list_changes` |
| Logs | `analyze_log`, `list_log_channels`, `log_anomalies`, `log_what_changed`, `log_table`, `log_events`, `log_states` |
| Live robot | `inspect_live_robot` (read-only) |

None of them deploy robot code or command the robot. Use your normal build and deploy tools.

## Saving projects safely

The app and agents can edit `robot.mayhem.json` at the same time. Every save carries the revision it was based on; a save based on an old revision is refused, and the writer re-reads and tries again. Use `save` / `save_project` or `machine apply` rather than writing the file by hand.

The complete agent reference, including every option, is in [docs/SUITE_AGENTS.md](https://github.com/ryanabraham1/Mayhem/blob/main/docs/SUITE_AGENTS.md).
