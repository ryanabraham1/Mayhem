"""Optional MCP adapter. Install with `uv sync --extra mcp` in solver/."""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from .agent import AgentWorkspace, GUIDE
from .models import Project, Trajectory
from .rpc import list_fields


class PathWaypoint(BaseModel):
    """Convenient path authoring input. Advanced tolerances use save_trajectory."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    x: float
    y: float
    heading: float = 0.0
    stop: bool | None = None
    id: str | None = None
    heading_mode: Literal["fixed", "free"] = "fixed"
    translation_mode: Literal["fixed", "guide"] = "fixed"
    pose_ref: str | None = None


def create_server(workspace: AgentWorkspace):
    # Load NumPy/OpenBLAS/CasADi before stdio starts its background stdin reader.
    # On Windows, their first import inside a tool can deadlock against that read:
    # https://github.com/modelcontextprotocol/python-sdk/issues/2832
    from . import pipeline as _pipeline  # noqa: F401
    from mcp.server.fastmcp import FastMCP
    from mcp.types import ToolAnnotations

    @asynccontextmanager
    async def lifespan(_):
        try:
            yield workspace
        finally:
            import anyio
            await anyio.to_thread.run_sync(workspace.close)

    server = FastMCP("Mayhem", instructions=GUIDE, lifespan=lifespan)
    read = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False)
    create = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)

    @server.resource("mayhem://guide")
    def guide() -> str:
        """Mayhem units, file workflow, solver jobs, and deployment semantics."""
        return GUIDE

    @server.resource("mayhem://schema/{document}", mime_type="application/json")
    def schema_resource(document: str) -> str:
        """Full schemas for project or trajectory documents, including all constraints."""
        import json
        return json.dumps(get_schema(document))

    @server.tool(annotations=read)
    def workspace_info() -> dict:
        """Read Mayhem version, configured workspace boundary, and agent workflow."""
        return workspace.info()

    @server.tool(annotations=read)
    def get_schema(document: Literal["project", "trajectory"]) -> dict:
        """Read a complete input JSON Schema before authoring full documents. Uses SI units."""
        models = {"project": Project, "trajectory": Trajectory}
        if document not in models:
            raise ValueError("document must be project or trajectory")
        schema = models[document].model_json_schema(by_alias=True)
        # Agent input documents must never smuggle generated output into saved paths.
        if document == "trajectory":
            schema["properties"].pop("output", None)
        # Output-only definitions would add thousands of irrelevant tokens for agents.
        definitions = schema.pop("$defs", {})
        reachable = {}

        def visit(node):
            if isinstance(node, dict):
                if node.get("type") == "object" and "properties" in node:
                    node["additionalProperties"] = False
                ref = node.get("$ref", "")
                if ref.startswith("#/$defs/"):
                    name = ref.removeprefix("#/$defs/")
                    if name not in reachable:
                        reachable[name] = definitions[name]
                        visit(reachable[name])
                for value in node.values():
                    visit(value)
            elif isinstance(node, list):
                for value in node:
                    visit(value)

        visit(schema)
        if reachable:
            schema["$defs"] = reachable
        return schema

    @server.tool(annotations=read)
    def list_field_presets() -> list[dict]:
        """Read bundled field dimensions, obstacles, terrain, artwork, and alliance symmetry."""
        return list_fields()

    @server.tool(annotations=read)
    def list_directory(directory: str = ".") -> dict:
        """Discover folders and Mayhem files inside the workspace without reading unrelated files.

        Start at '.' and navigate by folder name to find saved projects.
        Hidden entries and symlinks outside the workspace are omitted.
        """
        return workspace.list_directory(directory)

    @server.tool(annotations=create)
    def create_project(directory: str, project: dict | None = None) -> dict:
        """Create a new saved project inside the workspace; refuses existing project files.

        Omit project for the default robot and REBUILT field. Otherwise supply a full
        project document using get_schema. Paths are relative to the workspace or absolute.
        """
        return workspace.create_project(directory, project)

    @server.tool(annotations=read)
    def inspect_project(directory: str) -> dict:
        """Read project configuration, revision, path names, and generated-output freshness.

        Returns summaries rather than thousands of trajectory samples. Use get_trajectory
        for editable inputs. Reads saved files, not unsaved desktop state.
        """
        return workspace.inspect_project(directory)

    @server.tool(annotations=write)
    def save_project(directory: str, project: dict, expected_revision: str) -> dict:
        """Replace project configuration with a full document from get_schema.

        Preserve existing fields; pass the revision from inspect_project. Editing robot,
        field, or poses can make generated paths stale. Does not deploy or generate.
        """
        return workspace.save_project(directory, project, expected_revision)

    @server.tool(annotations=read)
    def get_trajectory(directory: str, name: str, sample_offset: int = 0, sample_limit: int = 0) -> dict:
        """Read editable trajectory inputs, revision, output freshness, and generated events.

        name is the stored trajectory name, not its filename. Samples are omitted by
        default; request pages of at most 500 using sample_offset and sample_limit.
        """
        return workspace.get_trajectory(directory, name, sample_offset, sample_limit)

    @server.tool(annotations=create)
    def create_path(directory: str, name: str, waypoints: list[PathWaypoint],
                    constraints: list[dict] | None = None, markers: list[dict] | None = None,
                    settings: dict | None = None) -> dict:
        """Create a new path from coordinates; agents choose the route, headings, and actions.

        Supply at least two {x, y, heading} waypoints in meters/radians. IDs are
        generated automatically. Endpoints stop by default; intermediate points flow
        through unless stop=true. Explicit stop=false overrides endpoint defaults.
        Optional constraints/markers/settings follow get_schema('trajectory').
        Refuses existing names. Then validate_trajectory, start_solve, and save_solve.
        For advanced waypoint tolerances or later edits, use save_trajectory.
        """
        return workspace.create_path(directory, name, [p.model_dump(by_alias=True, exclude_unset=True) for p in waypoints],
                                     constraints, markers, settings)

    @server.tool(annotations=write)
    def save_trajectory(directory: str, trajectory: dict, expected_revision: str | None = None) -> dict:
        """Create/replace full trajectory inputs and clear old generated output.

        Read get_schema('trajectory') first. Use null revision only for new names; existing
        names require their current revision. Waypoint IDs must be unique, constraint and
        marker indices valid. Never supply output. Returns the new revision.
        """
        return workspace.save_trajectory(directory, trajectory, expected_revision)

    @server.tool(annotations=read)
    def validate_trajectory(directory: str, name: str) -> dict:
        """Preflight saved inputs for geometry, waypoint, and constraint diagnostics.

        This does not run the optimizer or prove a path is dynamically feasible.
        """
        return workspace.validate_trajectory(directory, name)

    @server.tool(annotations=create)
    def start_solve(directory: str, name: str) -> dict:
        """Generate a saved trajectory in a cancellable child process. Returns jobId promptly.

        Poll get_solve (e.g. every second). At most two jobs run concurrently. Results
        stay in memory until save_solve; failed/cancelled jobs never change files.
        """
        return workspace.start_solve(directory, name)

    @server.tool(annotations=read)
    def get_solve(job_id: str, sample_offset: int = 0, sample_limit: int = 0) -> dict:
        """Poll job status, progress, issues, stats, and optional pages of up to 500 samples.

        Status is running, succeeded, failed, or cancelled. Only the latest 32 jobs
        are retained, scoped to this server process. Completed results are not auto-saved.
        """
        return workspace.get_solve(job_id, sample_offset, sample_limit)

    @server.tool(annotations=write)
    def cancel_solve(job_id: str) -> dict:
        """Request child-process cancellation. Poll get_solve for terminal status."""
        return workspace.cancel_solve(job_id)

    @server.tool(annotations=write)
    def save_solve(job_id: str) -> dict:
        """Save successful solver output only if both source files still match their revisions.

        Refuses stale results after an edit, rename, or deletion. Never deploys automatically.
        """
        return workspace.save_solve(job_id)

    @server.tool(annotations=write)
    def deploy_trajectories(directory: str, names: list[str], target_directory: str) -> dict:
        """Copy explicitly named, current solved .mtraj files to a workspace-local target.

        Preflights the whole batch for stale output and filename collisions. The target
        is explicit; project.deployDir is not followed. This writes local files only,
        with no robot connection or WPILib deployment.
        """
        return workspace.deploy_trajectories(directory, names, target_directory)

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mayhem-mcp", description="Mayhem saved-project MCP server (stdio)")
    parser.add_argument("--workspace", required=True, help="Existing directory containing allowed projects/deploy targets")
    args = parser.parse_args(argv)
    try:
        import mcp  # noqa: F401
    except ImportError:
        parser.error("MCP support is optional. Install it with: cd solver && uv sync --extra mcp")
    workspace = AgentWorkspace(args.workspace)
    try:
        create_server(workspace).run(transport="stdio")
    finally:
        workspace.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
