# CampusPilot — student planning with MCP

CampusPilot is a student planning assistant built for the Alexa+ track of the Amazon Developer Hackathon. The web interface acts as an MCP client and calls a self-hosted Model Context Protocol (MCP) server over **Streamable HTTP**. It helps students prioritize assignments, allocate a study window, see deadline risks, and replan when tasks change.

## What it does

- Reads student tasks, deadlines, estimated durations, priorities, and completion status from the MCP server.
- Accepts planning requests such as “Plan my evening in 3 hours”, “Plan the next 90 minutes”, and “Plan my day”.
- Calls the `plan_schedule` MCP tool to rank open tasks and return time blocks plus tasks that do not fit.
- Adds and edits tasks, persists the updated list through the MCP `sync_tasks` tool, and marks tasks complete through `set_task_status`.
- Shows the actual MCP protocol steps and tool calls in the **Assistant activity** panel.
- Stores server-side demo tasks in `data/tasks.json` (created on first run); browser local storage is a fallback if the MCP server is unavailable.
- Includes a reset button for restoring demo tasks before recording a presentation.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_tasks` | Read the current task list and open-task count. |
| `sync_tasks` | Persist task additions and edits from the web client. |
| `set_task_status` | Complete or reopen a task by ID. |
| `plan_schedule` | Rank tasks and allocate them into a requested time window. |
| `reset_demo_tasks` | Restore the seven built-in demo tasks. |

The server uses the official MCP TypeScript/JavaScript SDK v1 line, which implements MCP specification version **2025-11-25**, and the Streamable HTTP transport. The browser sends `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` requests to `/mcp`.

## Requirements

- Node.js 20 or newer
- npm and internet access for the first dependency installation

## Run locally

From the project folder, run:

```bash
npm install
npm start
```

Open <http://127.0.0.1:3000>. Keep the terminal open while using the app. The MCP endpoint is <http://127.0.0.1:3000/mcp>; the health endpoint is <http://127.0.0.1:3000/health>.

To smoke-test the MCP protocol from a second terminal while the server is running:

```bash
npm run test:mcp
```

The test checks the MCP handshake, tool discovery, and `list_tasks` tool call. It does not reset or modify tasks.

## Recommended demo flow (under 3 minutes)

1. Start the app and show the MCP server terminal running.
2. Open CampusPilot; point out that the status says **MCP server connected** and the activity panel shows `initialize`, `tools/list`, and `tools/call · list_tasks`.
3. Click **Next 3 hours**. Show the request and the `plan_schedule` MCP tool call, then walk through the generated timeline and any tasks that do not fit.
4. Mark the first task complete. Show the `set_task_status` call and the updated schedule.
5. Add a small task or edit a deadline, then show `sync_tasks` persisting the change.
6. Briefly mention that CampusPilot is a focused student-planning MCP integration and does not connect to an actual Alexa+ device or use Amazon's gated partner-only Alexa+ tools.

Reset demo tasks before recording if you want a clean, repeatable run.

## Honest scope and limitations

- This project implements its own MCP server and web MCP client; it is **not connected to a real Alexa+ device or Alexa+ developer console**.
- The schedule ranking and request parsing are deterministic JavaScript logic, not a live LLM. Do not describe it as generative AI.
- The MCP server is intended for local hackathon demonstration. It binds to `127.0.0.1` and has no user authentication; do not expose it to the public internet as-is.
- No AWS service is integrated, so do not claim the AWS Builder mini-challenge.

## License

MIT. See `LICENSE`.

## Author

Ayush Raj
