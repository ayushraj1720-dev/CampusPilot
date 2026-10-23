
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:3000/mcp")
);
const client = new Client({ name: "campuspilot-tool-test", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Discovered tools:", tools.map(t => t.name).join(", "));

  const listed = await client.callTool({ name: "list_tasks", arguments: {} });
  const parsed = JSON.parse(listed.content.find(c => c.type === "text").text);
  console.log("PASS list_tasks:", parsed.tasks.length, "tasks");

  const planned = await client.callTool({
    name: "plan_schedule",
    arguments: { minutes: 60 }
  });
  console.log("plan_schedule:", planned.isError ? "FAILED" : "PASS");

  const firstTask = parsed.tasks[0];
  const sync = await client.callTool({
    name: "sync_tasks",
    arguments: { tasks: parsed.tasks }
  });
  console.log("sync_tasks:", sync.isError ? "FAILED" : "PASS");

  const status = await client.callTool({
    name: "set_task_status",
    arguments: { taskId: firstTask.id, done: !firstTask.done }
  });
  console.log("set_task_status:", status.isError ? "FAILED" : "PASS");

  // Restore the original task status.
  await client.callTool({
    name: "set_task_status",
    arguments: { taskId: firstTask.id, done: firstTask.done }
  });

  console.log("All non-reset tool checks finished.");
} catch (error) {
  console.error("TEST FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
