# Connect an agent

A coding agent (Claude Code, Codex or any agent that can run commands) works in its own chat: you tell it what the robot should do differently, it changes the code. Mayhem is where you check what it did, by what the robot does rather than by reading the diff. People stay in charge of the decision that matters: whether a change goes into `main` and onto the robot.

## Make its work show up ready to review

1. In the app, choose the robot code folder.
2. Open **Settings → Agents and the project file → Tell your agent once** and copy the text. It has this robot's folder filled in.
3. Paste it into your agent's chat, or into the robot repo's `CLAUDE.md` or `AGENTS.md`.

From then on the agent works on a branch, checks its own change with Mayhem's tools, and records a sim proof on its commit. The branch appears under **Changes → To review** with its risk and that proof. See [How changes get reviewed](/agents/review).

## Give it Mayhem's tools (MCP)

The agent works best with Mayhem's tools: analyzing logs, running the sim proof, diffing behavior. Add the Mayhem MCP server to your agent's configuration:

```json
{
  "mcpServers": {
    "mayhem": {
      "command": "node",
      "args": ["/absolute/path/to/Mayhem/scripts/mayhem.mjs", "mcp"]
    }
  }
}
```

Use the path to a Mayhem checkout or to the extracted `Mayhem-suite-tools` folder from a release. It needs Node 24 or later. **Settings → Agents and the project file → Connect over MCP** shows the same setup.

Agents without MCP can call every tool from the shell: `node scripts/mayhem.mjs tool <name> '<JSON>'`. See [Command line and MCP tools](/agents/tools).

## Other panels under Agents and the project file

| Panel | Use |
| --- | --- |
| **Share this project with an agent** | A brief describing the project, for a one-off request ("add a second auto"). |
| **Live file link** | **Save project file** links the project to `robot.mayhem.json`, so an agent's edits show up in the app within a second. |
| **Command line** | The `scripts/mayhem.mjs` commands. |
| **C++ library** | Export the routines as a C++ header. |
| **Project document** | The raw project JSON. |

## What agents can and can't do

- They **can** edit robot code, the project file, machines and scenarios; run the simulation; read logs; and commit on their own branch.
- They **can't** command the robot. Mayhem only reads NetworkTables, and the MCP tools never deploy.
- They **don't** push to `main`. `main` is the known-good version, and putting it back on the robot is a button only people press.

After an agent edits a routine, look at the field and the graph, and preview it before running it on the robot.
