# Mayhem for AI agents

Mayhem includes a local **MCP server** that lets agents discover saved projects,
read robot/field configuration, author trajectories and event markers, validate
inputs, generate paths, inspect diagnostics and samples, and copy generated paths
into a robot project's deploy folder. It uses the same models, field presets,
optimizer, and cancellable child-process jobs as the desktop app.

This interface works on **saved files**. Save and close the project in the desktop
editor before agent edits, then reopen it afterward. The server does not read an
open editor's unsaved changes or update its in-memory state.

## Install and connect

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/).
Download the `mayhem_solver-0.8.5-py3-none-any.whl` package from
[GitHub Releases](https://github.com/ryanabraham1/Mayhem/releases/tag/v0.8.5), then install it:

```sh
uv tool install --with 'mcp>=1.28,<2' /path/to/mayhem_solver-0.8.5-py3-none-any.whl
mayhem-mcp --workspace /absolute/path/to/robot-workspace
```

For a wheel installation, configure your MCP client with command `mayhem-mcp` and
arguments `["--workspace", "/absolute/path/to/robot-workspace"]`. Use an absolute
path to the installed command if needed.

Alternatively, from the Mayhem checkout:

```sh
cd solver
uv sync --extra mcp
```

Choose an existing workspace directory containing the Mayhem projects and deploy
folders the agent may access. Use a common parent if the Mayhem project and robot
project are siblings. Everything outside that directory is inaccessible, including
through symlinks. The server opens no network port and requires no API key.

Configure a stdio MCP connection in your agent's MCP settings. For example, an
MCP client using `mcpServers` JSON can use:

```json
{
  "mcpServers": {
    "mayhem": {
      "command": "uv",
      "args": [
        "--directory", "/Users/ryanabraham/Downloads/Mayhem/solver",
        "run", "--frozen", "--extra", "mcp",
        "mayhem-mcp", "--workspace", "/absolute/path/to/robot-workspace"
      ]
    }
  }
}
```

Replace the checkout path on another machine and replace the workspace placeholder
with your real directory. Use the absolute path to `uv` if the client doesn't
inherit your shell's PATH. Clients using a command/arguments form can use the same
values without the JSON wrapper. Restart/reconnect the client after changing its
configuration.

You can also launch it directly (it then waits for MCP messages on stdin):

```sh
uv --directory /Users/ryanabraham/Downloads/Mayhem/solver run --frozen --extra mcp \
  mayhem-mcp --workspace /absolute/path/to/robot-workspace
```

The SDK follows the [official Python MCP stdio interface](https://py.sdk.modelcontextprotocol.io/v1/).
MCP is an optional dependency pinned to its 1.x API; ordinary solver and desktop
builds do not need it. Use either the Python wheel or a source checkout;
the desktop installer alone does not install this command.

## Tools

| Tool | Purpose |
|---|---|
| `workspace_info` | Version, allowed root, instructions, and solver concurrency |
| `list_directory` | Discover folders and saved Mayhem projects |
| `get_schema` | Complete project or trajectory JSON Schema |
| `list_field_presets` | Field dimensions, obstacles, terrain, and symmetry |
| `create_project` | Create a project; defaults to REBUILT and the default robot |
| `inspect_project` | Read configuration, file revision, trajectory summaries, output freshness |
| `save_project` | Replace project configuration with revision checking |
| `get_trajectory` | Read editable inputs, generated events/stats, optional sample pages |
| `create_path` | Create a path from coordinates with generated IDs and stopped endpoints |
| `save_trajectory` | Create or replace full trajectory inputs, clearing generated output |
| `validate_trajectory` | Geometry and input preflight with actionable diagnostics |
| `start_solve` | Launch generation and return a job ID |
| `get_solve` | Poll progress/result and optionally inspect sample pages |
| `cancel_solve` | Cancel a child solver process |
| `save_solve` | Save a successful result whose source files still match |
| `deploy_trajectories` | Copy explicit current paths to an explicit local deploy directory |

Resources: `mayhem://guide`, `mayhem://schema/project`, and
`mayhem://schema/trajectory`. The same schemas are available as tools for clients
that don't surface resources. MCP clients receive tool errors for invalid calls;
solver infeasibility is returned as a failed job with its diagnostics.

## Example agent workflow

Ask your connected agent:

> Use Mayhem to inspect my robot's saved project, add a path from (2, 2) to (4, 2)
> with heading 0 and stopped endpoints, generate it, and show its duration and any
> diagnostics. Save the successful path. Don't deploy it yet.

The underlying sequence is:

1. Use `list_directory`, `inspect_project`, and `get_schema` to inspect the existing
   robot, field, constraints, and file formats. Avoid replacing measured robot
   configuration with defaults.
2. Call `create_path` with waypoints. The agent chooses coordinates, headings,
   intermediate stops, constraints, and markers from your request. For example:

   ```json
   {
     "directory": "my-project",
     "name": "Straight",
     "waypoints": [
       {"x": 2, "y": 2, "heading": 0},
       {"x": 4, "y": 2, "heading": 0}
     ],
     "markers": [
       {"id": "intake", "name": "Intake", "command": "intake", "waypoint": 0}
     ]
   }
   ```

   This creates a new path, generates stable waypoint IDs, and defaults both
   endpoints to stopped. Intermediate waypoints flow through unless `stop: true`;
   an explicit `stop: false` overrides the endpoint default. Existing names are
   never overwritten by `create_path`.

   To edit an existing path or use advanced waypoint tolerances, get its current
   full inputs and revision from `get_trajectory`, preserve the fields you need,
   and call `save_trajectory` with that document and `expected_revision`. Creating
   via `save_trajectory` instead requires `expected_revision: null`. Project saves
   use the revision returned by `inspect_project`. Stale revisions fail without
   overwriting the file. An input save always clears old trajectory output;
   supplying generated output is rejected.
3. Run `validate_trajectory`. This preflight reports geometry/input problems; a
   valid preflight does not establish dynamic feasibility.
4. Call `start_solve` and poll `get_solve` about once a second until status becomes
   `succeeded`, `failed`, or `cancelled`. Report `issues` on failure and revise the
   inputs when appropriate. For inspection, request `sample_limit` up to 500 and
   continue from `nextSampleOffset`.
5. Call `save_solve` on success. It refuses to save if either source file changed
   after generation, even if the solve itself succeeded. Re-read and regenerate
   after a revision conflict. Results exist only in this MCP process until saved;
   at most two solves run at once, and the latest 32 jobs remain available.
6. When asked to deploy, call `deploy_trajectories` with explicit path names and an
   explicit workspace-local target, usually `robot/src/main/deploy/mayhem`.
   Missing, stale, or failed output blocks the batch before writing any files.
   The project setting `deployDir` is not followed automatically. Copying local
   files is separate from deploying a robot project through WPILib.

All file writes use a complete temporary file and atomic replacement. Revision
checks protect against edits made before the write check; they do not lock other
processes or make a multi-file batch transactional. Avoid concurrent editor/agent
writes to the same project. Filename collisions are checked before saving/deploying.

## Coordinate and authoring rules

- Use meters, radians, seconds, kilograms, and newtons. Coordinates use WPILib's
  blue-alliance origin. Author blue paths; MayhemLib flips for red at runtime.
- Use stable unique waypoint IDs. Constraint/marker indices are zero-based; update
  references if waypoints are reordered or removed. At least two waypoints are
  needed to solve. Endpoints commonly have `stop: true`.
- Preserve `poseRef` links to project pose variables. Discover valid IDs from the
  project. Use schema-defined constraint variants and scopes rather than invented
  fields. Unknown fields and nonfinite values in writes are rejected.
- Project edits to robot, field, or pose variables can stale existing outputs.
  Check `outputCurrent` before using generated samples or deploying a path.
- Cancellation is a request; poll until terminal status. Server shutdown cancels
  its outstanding child jobs. A client may finish a very short job before the
  cancellation request arrives.

Python integrations without MCP can use
`mayhem_solver.agent.AgentWorkspace(root)` and its matching methods directly.
Call `close()` in a `finally` block to clean up child jobs.

## Verify development changes

```sh
cd solver
uv run --frozen --extra mcp pytest -q
```

The MCP integration test starts a real stdio server and MCP client, generates a
trajectory through the real child solver, checks samples/events, saves/deploys it,
rejects stale deployment, and exercises cancellation. CI runs this test on Linux,
macOS, and Windows with the optional MCP dependency installed.
