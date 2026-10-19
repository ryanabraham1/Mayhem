"""Real MCP client -> stdio server -> child solver -> saved/deployed files."""
import asyncio
import json
import os
import sys
import traceback
from contextlib import asynccontextmanager

import pytest

pytest.importorskip("mcp")

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def test_mcp_stdio_end_to_end(tmp_path):
    async def scenario():
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "mayhem_solver.mcp_server", "--workspace", str(tmp_path)],
            env={**os.environ, "MAYHEM_JOB_MODE": "subprocess"},
        )
        async with stdio_client(params) as (read, write):
            @asynccontextmanager
            async def session():
                async with ClientSession(read, write) as client:
                    try:
                        yield client
                    except BaseException:
                        # The SDK's Windows pipe teardown can mask the original error.
                        traceback.print_exc()
                        raise

            async with session() as client:
                initialized = await client.initialize()
                assert initialized.serverInfo.name == "Mayhem"
                tools = {t.name: t for t in (await client.list_tools()).tools}
                assert {"start_solve", "cancel_solve", "save_solve", "deploy_trajectories"} <= tools.keys()
                assert tools["inspect_project"].annotations.readOnlyHint
                guide = await client.read_resource("mayhem://guide")
                assert "radians" in guide.contents[0].text
                schema = await client.read_resource("mayhem://schema/trajectory")
                input_schema = json.loads(schema.contents[0].text)
                assert "waypoints" in input_schema["properties"]
                assert "TrajectoryOutput" not in input_schema["$defs"]
                assert input_schema["additionalProperties"] is False
                point_schema = tools["create_path"].inputSchema
                assert point_schema["$defs"]["PathWaypoint"]["required"] == ["x", "y"]

                async def call(tool_name, **arguments):
                    result = await client.call_tool(tool_name, arguments)
                    assert not result.isError, result.content
                    return result.structuredContent or json.loads(result.content[0].text)

                bad = await client.call_tool("create_project", {"directory": "../escape"})
                assert bad.isError
                p = await call("create_project", directory="auto", project={"name": "Agent demo"})
                assert p["trajectories"] == []
                created = await call("create_path", directory="auto", name="Straight",
                                     waypoints=[{"x": 2, "y": 2}, {"x": 4, "y": 2}],
                                     settings={"candidates": 1, "timeLimit": 15},
                                     markers=[{"id": "intake", "name": "Intake", "command": "intake", "waypoint": 0}])
                assert all(w["stop"] and w["id"] for w in created["trajectory"]["waypoints"])
                assert (await call("validate_trajectory", directory="auto", name="Straight"))["valid"]
                job = await call("start_solve", directory="auto", name="Straight")
                for _ in range(150):
                    state = await call("get_solve", job_id=job["jobId"], sample_limit=2)
                    if state["status"] != "running":
                        break
                    await asyncio.sleep(0.2)
                assert state["status"] == "succeeded", state
                assert len(state["samples"]) == 2 and state["sampleCount"] > 2
                assert state["nextSampleOffset"] == 2
                assert json.loads((tmp_path / "auto/Straight.mtraj").read_text())["output"] is None
                saved = await call("save_solve", job_id=job["jobId"])
                assert saved["outputCurrent"]
                assert saved["generated"]["events"][0]["command"] == "intake"
                deployed = await call("deploy_trajectories", directory="auto", names=["Straight"],
                                      target_directory="robot/src/main/deploy/mayhem")
                assert len(deployed["written"]) == 1
                assert json.loads((tmp_path / "robot/src/main/deploy/mayhem/Straight.mtraj").read_text())["output"]["samples"]
                p["project"]["robot"]["mass"] = 65
                await call("save_project", directory="auto", project=p["project"], expected_revision=p["revision"])
                stale = await client.call_tool("deploy_trajectories", {
                    "directory": "auto", "names": ["Straight"], "target_directory": "other"})
                assert stale.isError and not (tmp_path / "other").exists()
                job2 = await call("start_solve", directory="auto", name="Straight")
                await call("cancel_solve", job_id=job2["jobId"])
                for _ in range(100):
                    state = await call("get_solve", job_id=job2["jobId"])
                    if state["status"] != "running":
                        break
                    await asyncio.sleep(0.1)
                assert state["status"] in ("cancelled", "succeeded"), state

    asyncio.run(asyncio.wait_for(scenario(), timeout=90))
