import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.MCP_URL || 'http://127.0.0.1:3000/mcp';
const client = new Client({ name: 'campuspilot-smoke-test', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const expected = ['list_tasks', 'sync_tasks', 'set_task_status', 'plan_schedule', 'reset_demo_tasks'];
  for (const name of expected) assert.ok(tools.some((tool) => tool.name === name), `Missing MCP tool: ${name}`);
  const result = await client.callTool({ name: 'list_tasks', arguments: {} });
  const text = (result.content || []).find((part) => part.type === 'text')?.text || '';
  const payload = result.structuredContent || JSON.parse(text);
  assert.ok(Array.isArray(payload.tasks), 'list_tasks did not return a task array');
  assert.ok(payload.tasks.length > 0, 'No demo tasks were returned');
  console.log(`PASS: MCP handshake, tools/list, and list_tasks succeeded (${tools.length} tools, ${payload.tasks.length} tasks).`);
} finally {
  await client.close();
}
