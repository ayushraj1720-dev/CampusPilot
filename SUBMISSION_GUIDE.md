# CampusPilot — Devpost submission guide

Use this as a checklist and draft. Replace any statement that does not match your final repository or actual experience.

## Suggested project description

**CampusPilot — an MCP-powered student planning assistant**

CampusPilot helps students turn a list of assignments into a realistic study plan. Its browser interface connects to a self-hosted Model Context Protocol (MCP) server over Streamable HTTP. The client performs the MCP initialization handshake, discovers available tools, reads task data, calls the schedule-planning tool, and persists task updates through server tools.

The planning workflow ranks open tasks using deadline urgency and priority, allocates them into a requested time window, and reports tasks that do not fit or may finish after their deadlines. Students can add or edit tasks, mark tasks complete, and see the schedule recalculate. An activity panel makes the MCP tool calls visible, so the demo shows not just a chat-like interface but the actual client-server tool workflow.

The scheduling engine is deterministic JavaScript rather than a live LLM. CampusPilot is not connected to an Alexa+ device or Amazon's partner-only Alexa+ developer tools; it demonstrates an Alexa+-relevant MCP integration through its own web client.

## Primary track

- **Alexa+** — self-hosted MCP server using Streamable HTTP, plus a web client that demonstrates MCP tool discovery and calls.
- Do not select **AWS Builder** unless you separately add and document a qualifying AWS integration.
- Do not select **Open Source mini-challenge** based only on this same primary submission. The rules ask for an additional open-source project or contribution alongside the primary track submission.

## Testing instructions for Devpost

1. Install Node.js 20 or newer.
2. Clone or download the public repository.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://127.0.0.1:3000`.
6. Verify the status shows **MCP server connected**.
7. Click **Next 3 hours** and inspect the Assistant activity panel for `initialize`, `tools/list`, and `tools/call · plan_schedule`.
8. Mark a task complete and verify the `set_task_status` call and schedule update.
9. Run `npm run test:mcp` in a second terminal to smoke-test MCP initialization, tool discovery, and `list_tasks`.

## Suggested demo video script (about 2 minutes 20 seconds)

**0:00–0:15 — Problem and product**  
“Students often have multiple assignments with different deadlines and limited study time. CampusPilot turns that task list into a prioritized plan.”

**0:15–0:35 — Show the architecture working**  
Show the terminal running `npm start`, then the browser's connected status. Point to `initialize`, `tools/list`, and `tools/call · list_tasks` in the activity panel. Say: “This browser page is an MCP client talking to my self-hosted MCP server over Streamable HTTP.”

**0:35–1:10 — Generate a plan**  
Click **Next 3 hours**. Show the schedule timeline, deadline warning or skipped tasks, and the `plan_schedule` tool call. Explain that the current planner uses deterministic deadline/priority rules, not a live LLM.

**1:10–1:40 — Change the plan**  
Mark the first task complete. Show `set_task_status` and the updated schedule. Add or edit a task and show `sync_tasks`.

**1:40–2:05 — Explain impact and scope**  
“CampusPilot makes the tool workflow observable and gives students a quick plan they can adapt. It is a self-hosted MCP demo, not a real Alexa+ device integration.”

**2:05–2:20 — Close**  
Show the GitHub repository, README setup instructions, and MIT license.

Record the actual running application. Keep the final video under three minutes and upload it publicly to YouTube or Vimeo.

## Product feedback draft — verify before submitting

The hackathon asks for feedback on each tool, API, or SDK used. This is a starter draft; edit it to reflect what you actually experienced while installing and testing.

### Model Context Protocol JavaScript SDK
- **Use:** Implemented the CampusPilot MCP server with Streamable HTTP and registered task-list, task-sync, task-status, schedule-planning, and demo-reset tools.
- **What worked well:** The SDK provides the protocol handshake, tool discovery, input validation, and transport implementation, avoiding a hand-written MCP protocol layer.
- **What needs work:** First-time setup can be confusing because transport, protocol version, and request headers must match the spec; the browser-side client must also handle JSON and error responses carefully.
- **Onboarding:** Replace this sentence with your real experience after running `npm install`, `npm start`, and `npm run test:mcp`.
- **Build again?** Choose Yes/No based on your experience and explain why.

### Node.js, Express, and Zod
- **Use:** Node.js runs the server, Express serves the web app and MCP endpoint, and Zod validates tool inputs.
- **What worked well:** A single local process serves both the demo interface and MCP endpoint; schemas make the expected tool arguments explicit.
- **What needs work:** First-time dependency installation requires network access, and server errors must be surfaced clearly in the browser.
- **Onboarding:** Replace with your real installation/testing experience.
- **Build again?** Choose Yes/No based on your experience and explain why.

### Browser APIs (Fetch, localStorage, HTML/CSS/JavaScript)
- **Use:** The browser performs MCP requests, renders task and schedule views, and retains a local fallback copy.
- **What worked well:** The UI stays lightweight and shows the tool workflow without a separate frontend framework.
- **What needs work:** The browser client must handle a disconnected server and keep local and server task state synchronized.
- **Onboarding:** Replace with your real experience.
- **Build again?** Choose Yes/No based on your experience and explain why.

## Final pre-submit checklist

- [ ] Push the latest CampusPilot files to a **public GitHub repository** (or use the private-repository sharing route in the official rules).
- [ ] Confirm `LICENSE` is visible in the repository and the repository has setup instructions.
- [ ] Run `npm install`, `npm start`, and `npm run test:mcp` on your own computer.
- [ ] Record a public demo video under three minutes that clearly shows MCP calls at runtime.
- [ ] Add the public video URL and repository URL to Devpost.
- [ ] Select the Alexa+ primary track.
- [ ] Complete product feedback honestly for the tools actually used.
- [ ] Do not claim live AI, real Alexa+ device integration, AWS integration, or an Open Source mini-challenge contribution unless you actually add and demonstrate them.
- [ ] Submit before the deadline shown on the official Devpost page.
