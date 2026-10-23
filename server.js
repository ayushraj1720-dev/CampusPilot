import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };

fs.mkdirSync(DATA_DIR, { recursive: true });

function localDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function seedTasks() {
  const now = new Date();
  const inHours = (h) => localDateTime(new Date(now.getTime() + h * 3600000));
  const at = (days, hour) => localDateTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0));
  return [
    { id: 'demo-dbms', title: 'Submit DBMS lab assignment', deadline: inHours(5), priority: 'high', duration: 90, done: false },
    { id: 'demo-thermo', title: 'Revise thermodynamics for MidSem', deadline: at(1, 9), priority: 'high', duration: 120, done: false },
    { id: 'demo-aptitude', title: 'Practice 10 aptitude questions', deadline: inHours(9), priority: 'medium', duration: 30, done: false },
    { id: 'demo-slides', title: 'Draft hackathon demo slides', deadline: at(2, 18), priority: 'medium', duration: 60, done: false },
    { id: 'demo-os', title: 'Read OS chapter 5', deadline: at(3, 12), priority: 'medium', duration: 45, done: false },
    { id: 'demo-email', title: 'Email professor about project guidance', deadline: at(1, 17), priority: 'low', duration: 15, done: false },
    { id: 'demo-laundry', title: 'Laundry and room cleanup', deadline: at(4, 20), priority: 'low', duration: 40, done: false }
  ];
}
function sanitizeTask(task) {
  if (!task || typeof task !== 'object') throw new Error('Each task must be an object.');
  const title = String(task.title || '').trim().slice(0, 80);
  const deadline = String(task.deadline || '');
  const duration = Number(task.duration);
  const priority = PRIORITY_WEIGHT[task.priority] ? task.priority : 'medium';
  if (!title) throw new Error('Task title is required.');
  if (!deadline || Number.isNaN(new Date(deadline).getTime())) throw new Error(`Task "${title}" needs a valid deadline.`);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new Error('Duration must be a whole number from 5 to 480 minutes.');
  return {
    id: String(task.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    title, deadline, duration, priority, done: task.done === true
  };
}
function readTasks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed.map(sanitizeTask);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read task data; restoring demo tasks:', error.message);
  }
  const seeded = seedTasks();
  writeTasks(seeded);
  return seeded;
}
function writeTasks(tasks) {
  const safe = tasks.map(sanitizeTask);
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}
let tasks = readTasks();
function urgency(task, now) {
  const hours = (new Date(task.deadline).getTime() - now) / 3600000;
  let score = hours < 0 ? 100 : hours <= 3 ? 50 : hours <= 24 ? 35 : hours <= 72 ? 20 : hours <= 168 ? 10 : 0;
  return score + PRIORITY_WEIGHT[task.priority] * 12;
}
function buildPlan(minutes, startAt) {
  const start = startAt ? new Date(startAt) : new Date();
  if (Number.isNaN(start.getTime())) throw new Error('startAt must be a valid date-time.');
  const duration = Number(minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw new Error('Plan length must be 15 to 720 whole minutes.');
  const end = new Date(start.getTime() + duration * 60000);
  const open = tasks.filter((task) => !task.done).slice().sort((a, b) => {
    const score = urgency(b, start.getTime()) - urgency(a, start.getTime());
    return score || new Date(a.deadline) - new Date(b.deadline) || a.title.localeCompare(b.title);
  });
  const blocks = [];
  const skipped = [];
  let cursor = start.getTime();
  for (const task of open) {
    const remaining = Math.floor((end.getTime() - cursor) / 60000);
    if (task.duration <= remaining) {
      const blockEnd = cursor + task.duration * 60000;
      blocks.push({ taskId: task.id, title: task.title, start: new Date(cursor).toISOString(), end: new Date(blockEnd).toISOString(), minutes: task.duration, partial: false, late: blockEnd > new Date(task.deadline).getTime() });
      cursor = blockEnd;
    } else skipped.push(task);
  }
  let free = Math.floor((end.getTime() - cursor) / 60000);
  if (skipped.length && free >= 15) {
    const task = skipped.shift();
    const blockEnd = cursor + free * 60000;
    blocks.push({ taskId: task.id, title: task.title, start: new Date(cursor).toISOString(), end: new Date(blockEnd).toISOString(), minutes: free, partial: true, needsMore: task.duration - free, late: blockEnd > new Date(task.deadline).getTime() });
    cursor = blockEnd;
    free = 0;
  }
  return {
    start: start.toISOString(), end: end.toISOString(), windowMinutes: duration,
    openTaskCount: open.length, plannedTaskCount: blocks.length,
    usedMinutes: Math.round((cursor - start.getTime()) / 60000), freeMinutes: Math.max(0, free),
    blocks, skipped: skipped.map(({ id, title, deadline, duration, priority }) => ({ id, title, deadline, duration, priority }))
  };
}
function createMcpServer() {
  const server = new McpServer({ name: 'campuspilot-student-planner', version: '1.0.0' });

  server.registerTool('list_tasks', {
    title: 'List student tasks',
    description: 'Return all student tasks, including deadlines, durations, priorities, and completion status.',
    inputSchema: {}
  }, async () => {
    const result = { tasks, openCount: tasks.filter((task) => !task.done).length };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('sync_tasks', {
    title: 'Save task list',
    description: 'Persist the current task list from the CampusPilot web client so planning tools use the latest tasks.',
    inputSchema: { tasks: z.array(z.object({ id: z.string(), title: z.string(), deadline: z.string(), duration: z.number(), priority: z.enum(['high', 'medium', 'low']), done: z.boolean() })).max(200) }
  }, async ({ tasks: incoming }) => {
    tasks = writeTasks(incoming);
    const result = { saved: tasks.length, openCount: tasks.filter((task) => !task.done).length, message: 'Task list saved to the CampusPilot MCP server.' };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('set_task_status', {
    title: 'Update task status',
    description: 'Mark a task complete or reopen it using its task ID.',
    inputSchema: { taskId: z.string(), done: z.boolean() }
  }, async ({ taskId, done }) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return { isError: true, content: [{ type: 'text', text: `Task not found: ${taskId}` }] };
    task.done = done;
    tasks = writeTasks(tasks);
    const result = { task, openCount: tasks.filter((item) => !item.done).length };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('plan_schedule', {
    title: 'Build a study schedule',
    description: 'Rank open tasks by urgency, priority and deadline, then allocate them into the requested time window. Returns time blocks and tasks that do not fit.',
    inputSchema: { minutes: z.number().int().min(15).max(720), startAt: z.string().optional() }
  }, async ({ minutes, startAt }) => {
    try {
      const result = buildPlan(minutes, startAt);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

  server.registerTool('reset_demo_tasks', {
    title: 'Reset demo tasks',
    description: 'Replace the current task list with the seven built-in demo tasks. This removes current task edits.',
    inputSchema: {}
  }, async () => {
    tasks = writeTasks(seedTasks());
    const result = { tasks, message: 'Demo tasks restored.' };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

const app = createMcpExpressApp({ host: '127.0.0.1' });
app.use('/data', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'CampusPilot MCP', protocol: '2025-11-25', tools: ['list_tasks', 'sync_tasks', 'set_task_status', 'plan_schedule', 'reset_demo_tasks'] }));
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP server error' }, id: req.body?.id ?? null });
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'MCP Streamable HTTP requests must use POST.' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'This stateless MCP endpoint does not use DELETE.' }));
app.listen(PORT, '127.0.0.1', () => console.log(`CampusPilot web app + MCP server running at http://127.0.0.1:${PORT} (MCP endpoint: /mcp)`));
