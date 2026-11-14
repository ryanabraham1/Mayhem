# Connect an agent

A coding agent (Claude Code, Codex or any agent that can run commands) can work your team's [task queue](/suite/tasks): read the feedback, investigate with the logs and the simulation, propose a plan in plain English, and change the robot code once a person approves. People stay in charge of two decisions: whether the plan is right, and whether the change is.

## Put an agent on the queue

1. In the app, choose the robot code folder.
2. Open **Tasks → Connect an agent → Put an agent on the queue** and copy the prompt. It has this robot's folder filled in.
3. Open your agent **in the robot code folder** and paste it.

The agent then picks up the next task, proposes a plan, and waits for you. The line above the Tasks board names each agent on the queue and when it last did something.

::: tip Keep it running
If the robot repo has the `mayhem-tasks` skill (in `.claude/skills/`), Claude Code can work the queue on a timer: `/loop 10m /mayhem-tasks`.
:::

## Give it Mayhem's tools (MCP)

The agent works best with Mayhem's tools: reading tasks, analyzing logs, running the sim proof, diffing behavior. Add the Mayhem MCP server to your agent's configuration:

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

Use the path to a Mayhem checkout or to the extracted `Mayhem-suite-tools` folder from a release. It needs Node 24 or later. **Tasks → Connect an agent → Connect over MCP** shows the same setup with your path filled in.

Agents without MCP can call every tool from the shell: `node scripts/mayhem.mjs tool <name> '<JSON>'`. See [Command line and MCP tools](/agents/tools).

## Other panels under Connect an agent

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
