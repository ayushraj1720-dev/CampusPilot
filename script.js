(function () {
  'use strict';

  var STORAGE_KEY = 'campuspilot.tasks.v1';
  var MIN_BLOCK = 15;          // smallest session (minutes) worth scheduling
  var MAX_WINDOW = 720;        // longest plan window: 12 hours
  var DAY_END_HOUR = 22;       // "plan my day" runs until 10 PM
  var PX_PER_MINUTE = 1.2;     // timeline block height per minute of work
  var PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
  var PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  var PERIOD_START = { morning: 8, afternoon: 13, evening: 18, night: 20 };

  var tasks = [];
  var plan = null;             // { start: ms, minutes: number, label: string }
  var storageOk = true;
  var mcpConnected = false;
  var mcpRequestId = 0;
  var mcpProtocolVersion = '2025-11-25';


  /* ---------- MCP client (Streamable HTTP) ---------- */

  function setMcpStatus(mode, message) {
    var status = $('mcp-status');
    if (!status) { return; }
    status.className = 'assistant-mode ' + mode;
    status.textContent = '';
    status.appendChild(el('span', 'status-dot'));
    var copy = el('span');
    var strong = el('strong', null, message);
    copy.appendChild(strong);
    copy.appendChild(document.createTextNode(mode === 'connected'
      ? ' · tools available over Streamable HTTP'
      : mode === 'offline' ? ' · local fallback mode' : ''));
    status.appendChild(copy);
  }

  function recordActivity(title, detail) {
    var list = $('tool-trace');
    if (!list) { return; }
    var idle = list.querySelector('.tool-idle');
    if (idle) { list.textContent = ''; }
    var item = el('li');
    item.appendChild(el('strong', null, title));
    item.appendChild(el('span', null, detail || 'Completed'));
    list.appendChild(item);
    while (list.children.length > 7) { list.removeChild(list.firstChild); }
    list.scrollTop = list.scrollHeight;
  }

  async function postMcp(payload, initialized) {
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (initialized) { headers['MCP-Protocol-Version'] = mcpProtocolVersion; }
    var response = await fetch('/mcp', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    if (response.status === 202 || response.status === 204) { return null; }
    var contentType = response.headers.get('content-type') || '';
    if (!response.ok) { throw new Error('MCP endpoint returned HTTP ' + response.status); }
    if (contentType.indexOf('application/json') === -1) {
      var raw = await response.text();
      var dataLine = raw.split('\n').find(function (line) { return line.indexOf('data:') === 0; });
      if (dataLine) { return JSON.parse(dataLine.slice(5).trim()); }
      throw new Error('Unexpected MCP response type: ' + contentType);
    }
    return response.json();
  }

  async function initializeMcpClient() {
    var initialized = await postMcp({
      jsonrpc: '2.0', id: ++mcpRequestId, method: 'initialize',
      params: { protocolVersion: mcpProtocolVersion, capabilities: {}, clientInfo: { name: 'CampusPilot Web Client', version: '1.0.0' } }
    }, false);
    if (!initialized || initialized.error || !initialized.result) {
      throw new Error(initialized && initialized.error ? initialized.error.message : 'MCP initialization did not return a result.');
    }
    mcpProtocolVersion = initialized.result.protocolVersion || mcpProtocolVersion;
    recordActivity('initialize', 'Negotiated MCP protocol ' + mcpProtocolVersion + '.');
    await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
    mcpConnected = true;
    var toolsResponse = await postMcp({ jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/list', params: {} }, true);
    if (!toolsResponse || toolsResponse.error) { throw new Error('Could not list MCP tools.'); }
    var names = (toolsResponse.result.tools || []).map(function (tool) { return tool.name; });
    recordActivity('tools/list', names.length + ' tools discovered: ' + names.join(', ') + '.');
    setMcpStatus('connected', 'MCP server connected');
    return callMcpTool('list_tasks', {});
  }

  function unpackToolResult(response) {
    if (!response || response.error) {
      throw new Error(response && response.error ? response.error.message : 'Empty MCP tool response.');
    }
    var result = response.result;
    if (!result) { throw new Error('MCP tool returned no result.'); }
    if (result.isError) {
      var errorText = (result.content || []).map(function (part) { return part.text || ''; }).join(' ');
      throw new Error(errorText || 'MCP tool call failed.');
    }
    if (result.structuredContent) { return result.structuredContent; }
    var textPart = (result.content || []).filter(function (part) { return part.type === 'text'; })[0];
    if (!textPart) { return result; }
    try { return JSON.parse(textPart.text); } catch (e) { return { message: textPart.text }; }
  }

  async function callMcpTool(name, args) {
    if (!mcpConnected) { throw new Error('CampusPilot MCP server is not connected.'); }
    var response = await postMcp({
      jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/call',
      params: { name: name, arguments: args || {} }
    }, true);
    var result = unpackToolResult(response);
    var detail = 'Success';
    if (name === 'list_tasks') { detail = result.openCount + ' open tasks loaded from the server.'; }
    else if (name === 'sync_tasks') { detail = result.saved + ' tasks saved; ' + result.openCount + ' remain open.'; }
    else if (name === 'set_task_status') { detail = 'Updated “' + result.task.title + '” to ' + (result.task.done ? 'complete' : 'open') + '.'; }
    else if (name === 'plan_schedule') { detail = result.plannedTaskCount + ' task blocks allocated across ' + result.windowMinutes + ' minutes; ' + result.freeMinutes + ' minutes free.'; }
    else if (name === 'reset_demo_tasks') { detail = 'Restored the built-in demo task list.'; }
    recordActivity('tools/call · ' + name, detail);
    return result;
  }

  async function syncTasksToMcp() {
    if (!mcpConnected) { return null; }
    return callMcpTool('sync_tasks', { tasks: tasks.map(function (task) {
      return { id: task.id, title: task.title, deadline: task.deadline, duration: Number(task.duration), priority: task.priority, done: task.done === true };
    }) });
  }

  /* ---------- Small helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function toInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function parseDeadline(value) {
    if (typeof value !== 'string' || !value) { return null; }
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function roundUp(ms, stepMinutes) {
    var step = stepMinutes * 60000;
    return Math.ceil(ms / step) * step;
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDuration(min) {
    var h = Math.floor(min / 60);
    var m = Math.round(min % 60);
    if (!h) { return m + ' min'; }
    if (!m) { return h + ' h'; }
    return h + ' h ' + m + ' min';
  }

  function formatDeadline(d) {
    var now = new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((b - a) / 86400000);
    var day;
    if (diff === 0) { day = 'Today'; }
    else if (diff === 1) { day = 'Tomorrow'; }
    else if (diff === -1) { day = 'Yesterday'; }
    else { day = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); }
    return day + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function spanText(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) { return 'less than a minute'; }
    if (min < 60) { return min + ' min'; }
    var h = Math.floor(min / 60);
    if (h < 48) { return h + ' h'; }
    return Math.floor(h / 24) + ' days';
  }

  function relativeDue(d) {
    var diff = d.getTime() - Date.now();
    return diff < 0 ? 'Overdue by ' + spanText(-diff) : 'Due in ' + spanText(diff);
  }

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) { return tasks[i]; }
    }
    return null;
  }

  function getOpen() {
    return tasks.filter(function (t) { return !t.done; });
  }

  function listNames(items, limit) {
    var names = items.slice(0, limit).map(function (t) { return '"' + t.title + '"'; });
    var text = names.join(', ');
    if (items.length > limit) { text += ' and ' + (items.length - limit) + ' more'; }
    return text;
  }

  /* ---------- Storage ---------- */

  function sanitizeTask(item) {
    if (!item || typeof item !== 'object') { return null; }
    var title = typeof item.title === 'string' ? item.title.trim().slice(0, 80) : '';
    if (!title || !parseDeadline(item.deadline)) { return null; }
    var duration = Number(item.duration);
    if (!isFinite(duration) || duration < 5 || duration > 480) { duration = 30; }
    return {
      id: typeof item.id === 'string' && item.id ? item.id : newId(),
      title: title,
      deadline: item.deadline,
      priority: PRIORITY_WEIGHT[item.priority] ? item.priority : 'medium',
      duration: Math.round(duration),
      done: item.done === true
    };
  }

  function loadTasks() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOk = false;
      return null;
    }
    if (raw === null) { return null; }
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!Array.isArray(data)) { return null; }
    return data.map(sanitizeTask).filter(Boolean);
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    $('storage-warning').hidden = storageOk;
  }

  function sampleTasks() {
    var now = new Date();
    function inHours(h) { return toInputValue(new Date(now.getTime() + h * 3600000)); }
    function at(daysAhead, hour) {
      return toInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, hour, 0));
    }
    return [
      { id: newId(), title: 'Submit DBMS lab assignment', deadline: inHours(5), priority: 'high', duration: 90, done: false },
      { id: newId(), title: 'Revise thermodynamics for MidSem', deadline: at(1, 9), priority: 'high', duration: 120, done: false },
      { id: newId(), title: 'Practice 10 aptitude questions', deadline: inHours(9), priority: 'medium', duration: 30, done: false },
      { id: newId(), title: 'Draft hackathon demo slides', deadline: at(2, 18), priority: 'medium', duration: 60, done: false },
      { id: newId(), title: 'Read OS chapter 5', deadline: at(3, 12), priority: 'medium', duration: 45, done: false },
      { id: newId(), title: 'Email professor about project guidance', deadline: at(1, 17), priority: 'low', duration: 15, done: false },
      { id: newId(), title: 'Laundry and room cleanup', deadline: at(4, 20), priority: 'low', duration: 40, done: false }
    ];
  }

  /* ---------- Scheduling ---------- */

  function urgencyScore(task, nowMs) {
    var d = parseDeadline(task.deadline);
    var hours = d ? (d.getTime() - nowMs) / 3600000 : 999;
    var urgency;
    if (hours < 0) { urgency = 100; }
    else if (hours <= 3) { urgency = 50; }
    else if (hours <= 24) { urgency = 35; }
    else if (hours <= 72) { urgency = 20; }
    else if (hours <= 168) { urgency = 10; }
    else { urgency = 0; }
    return urgency + PRIORITY_WEIGHT[task.priority] * 12;
  }

  function sortByUrgency(list) {
    var nowMs = Date.now();
    return list.slice().sort(function (a, b) {
      var diff = urgencyScore(b, nowMs) - urgencyScore(a, nowMs);
      if (diff !== 0) { return diff; }
      var da = parseDeadline(a.deadline), db = parseDeadline(b.deadline);
      var ta = da ? da.getTime() : 0, tb = db ? db.getTime() : 0;
      if (ta !== tb) { return ta - tb; }
      return a.title.localeCompare(b.title);
    });
  }

  function defaultPlan() {
    return { start: roundUp(Date.now(), 5), minutes: 180, label: 'the next 3 h' };
  }

  // The plan window never starts in the past: it shrinks as time passes.
  function currentWindow() {
    var nowRounded = roundUp(Date.now(), 5);
    var start = Math.max(plan.start, nowRounded);
    var end = plan.start + plan.minutes * 60000;
    return { start: start, end: end, minutes: Math.floor((end - start) / 60000) };
  }

  function makeBlock(task, startMs, minutes, partial) {
    var endMs = startMs + minutes * 60000;
    var d = parseDeadline(task.deadline);
    return {
      task: task,
      start: startMs,
      end: endMs,
      minutes: minutes,
      partial: partial,
      needsMore: partial ? task.duration - minutes : 0,
      late: d ? endMs > d.getTime() : false
    };
  }

  function applyServerPlan(serverPlan, fallback) {
    if (!serverPlan || !Array.isArray(serverPlan.blocks)) { return fallback; }
    var blocks = serverPlan.blocks.map(function (block) {
      var task = findTask(block.taskId);
      if (!task) {
        task = { id: block.taskId, title: block.title, deadline: '', duration: block.minutes, priority: 'medium', done: false };
      }
      return {
        task: task,
        start: new Date(block.start).getTime(),
        end: new Date(block.end).getTime(),
        minutes: block.minutes,
        partial: block.partial === true,
        needsMore: Number(block.needsMore || 0),
        late: block.late === true
      };
    });
    var skipped = (serverPlan.skipped || []).map(function (item) {
      return findTask(item.id) || { id: item.id, title: item.title, deadline: item.deadline, duration: item.duration, priority: item.priority || 'medium', done: false };
    });
    return {
      open: sortByUrgency(getOpen()),
      win: { start: new Date(serverPlan.start).getTime(), end: new Date(serverPlan.end).getTime(), minutes: serverPlan.windowMinutes },
      blocks: blocks,
      skipped: skipped,
      used: Number(serverPlan.usedMinutes || 0),
      freeMin: Number(serverPlan.freeMinutes || 0),
      expired: false
    };
  }

  function computeSchedule() {
    var open = sortByUrgency(getOpen());
    var win = currentWindow();
    var res = {
      open: open,
      win: win,
      blocks: [],
      skipped: [],
      used: 0,
      freeMin: 0,
      expired: win.minutes < MIN_BLOCK
    };
    if (!open.length || res.expired) { return res; }

    var cursor = win.start;
    open.forEach(function (task) {
      var remaining = (win.end - cursor) / 60000;
      if (task.duration <= remaining) {
        res.blocks.push(makeBlock(task, cursor, task.duration, false));
        cursor += task.duration * 60000;
      } else {
        res.skipped.push(task);
      }
    });

    // Leftover time goes to a partial session of the most urgent task that did not fit.
    var left = Math.floor((win.end - cursor) / 60000);
    if (res.skipped.length && left >= MIN_BLOCK) {
      var partialTask = res.skipped.shift();
      res.blocks.push(makeBlock(partialTask, cursor, left, true));
      cursor = win.end;
    }

    res.used = Math.round((cursor - win.start) / 60000);
    res.freeMin = Math.max(0, Math.round((win.end - cursor) / 60000));
    return res;
  }

  /* ---------- Chat request parsing ---------- */

  function parseRequest(text, now) {
    var t = text.toLowerCase();
    var nowMs = now.getTime();
    var total = 0;
    var found = false;

    var hours = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/);
    if (hours) {
      total += Math.round(parseFloat(hours[1]) * 60);
      found = true;
    } else if (/\bhalf an hour\b|\bhalf hour\b/.test(t)) {
      total += 30;
      found = true;
    } else if (/\ban hour\b/.test(t)) {
      total += 60;
      found = true;
    }
    var mins = t.match(/(\d+)\s*(?:minutes?|mins?|m)(?![a-z])/);
    if (mins) {
      total += parseInt(mins[1], 10);
      found = true;
    }

    var period = null;
    ['morning', 'afternoon', 'evening', 'night'].forEach(function (p) {
      if (!period && new RegExp('\\b' + p + '\\b').test(t)) { period = p; }
    });
    var wantsDay = /\b(today|day)\b/.test(t);

    var minutes;
    var label;
    var note = '';

    if (found) {
      minutes = total;
      label = period ? 'your ' + period : 'the next ' + formatDuration(minutes);
    } else if (wantsDay && !period) {
      minutes = null;
      label = 'the rest of today';
    } else if (period) {
      minutes = 180;
      label = 'your ' + period;
      note = 'No duration given, so I assumed 3 hours.';
    } else {
      return { error: 'I could not find how much time you have. Try "Plan my evening in 3 hours" or "Plan the next 90 minutes".' };
    }

    var startMs = nowMs;
    if (period) {
      var periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), PERIOD_START[period], 0).getTime();
      if (periodStart > nowMs) { startMs = periodStart; }
    }
    startMs = roundUp(startMs, 5);

    if (minutes === null) {
      var dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_END_HOUR, 0).getTime();
      minutes = Math.floor((dayEnd - startMs) / 60000);
      if (minutes < MIN_BLOCK) {
        return { error: 'Not enough of today is left, since planning stops at 10 PM. Try a specific length, like "Plan the next 2 hours".' };
      }
    }

    if (minutes < MIN_BLOCK) {
      return { error: 'A plan needs at least ' + MIN_BLOCK + ' minutes. Try something like "Plan the next 90 minutes".' };
    }
    if (minutes > MAX_WINDOW) {
      return { error: 'A plan can cover at most 12 hours. Try a shorter window.' };
    }

    return { plan: { start: startMs, minutes: minutes, label: label }, note: note };
  }

  function whyFirst(task) {
    var d = parseDeadline(task.deadline);
    return PRIORITY_LABEL[task.priority].toLowerCase() + ' priority, ' + (d ? relativeDue(d).toLowerCase() : 'no deadline');
  }

  function summarize(res, note) {
    if (!res.open.length) {
      return 'You have no open tasks to schedule. Add a task on the right and the schedule will update.';
    }
    if (res.expired) {
      return 'That window is too short to schedule anything. Try a longer one.';
    }
    var lines = [];
    var n = res.blocks.length;
    lines.push('Planned ' + n + (n === 1 ? ' task' : ' tasks') + ' for ' + plan.label + ', ' +
      formatTime(res.win.start) + ' to ' + formatTime(res.win.end) + '.');
    if (note) { lines.push(note); }

    var first = res.blocks[0];
    lines.push('Starting with "' + first.task.title + '" (' + whyFirst(first.task) + ').');

    var partial = res.blocks.filter(function (b) { return b.partial; })[0];
    if (partial) {
      lines.push('Only part of "' + partial.task.title + '" fits. It needs ' + formatDuration(partial.needsMore) + ' more in a later session.');
    }
    var late = res.blocks.filter(function (b) { return b.late; }).map(function (b) { return b.task; });
    if (late.length) {
      lines.push('Heads up: ' + listNames(late, 3) + ' would end after the deadline.');
    }
    if (res.skipped.length) {
      lines.push(res.skipped.length + (res.skipped.length === 1 ? ' task did' : ' tasks did') + ' not fit: ' +
        listNames(res.skipped, 3) + '. Ask for a longer window to include ' + (res.skipped.length === 1 ? 'it' : 'them') + '.');
    }
    if (res.freeMin > 0) {
      lines.push(formatDuration(res.freeMin) + ' stays free.');
    }
    return lines.join('\n');
  }

  /* ---------- Rendering ---------- */

  function priorityTag(priority) {
    return el('span', 'tag ' + priority, PRIORITY_LABEL[priority]);
  }

  function renderStats(res) {
    var now = Date.now();
    var open = getOpen();
    var soon = 0;
    var overdue = 0;
    open.forEach(function (t) {
      var d = parseDeadline(t.deadline);
      if (!d) { return; }
      var diff = d.getTime() - now;
      if (diff < 0) { overdue++; }
      else if (diff <= 86400000) { soon++; }
    });
    $('stat-open').textContent = open.length;
    $('stat-soon').textContent = soon;
    $('stat-overdue').textContent = overdue;
    $('stat-planned').textContent = formatDuration(res.used);
  }

  function renderTasks() {
    var list = $('task-list');
    list.textContent = '';

    if (!tasks.length) {
      var emptyItem = el('li', 'empty', 'No tasks yet. Add your first task above.');
      list.appendChild(emptyItem);
      return;
    }

    var ordered = sortByUrgency(getOpen()).concat(
      tasks.filter(function (t) { return t.done; }).sort(function (a, b) {
        return a.deadline < b.deadline ? -1 : 1;
      })
    );

    ordered.forEach(function (task) {
      var d = parseDeadline(task.deadline);
      var li = el('li', 'task priority-' + task.priority + (task.done ? ' done' : ''));

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'done-' + task.id;
      checkbox.checked = task.done;
      checkbox.title = task.done ? 'Mark as not done' : 'Mark as complete';
      checkbox.addEventListener('change', function () { toggleDone(task.id); });

      var main = el('div', 'task-main');
      var label = el('label', 'task-title', task.title);
      label.htmlFor = checkbox.id;
      var meta = el('div', 'meta');
      meta.appendChild(priorityTag(task.priority));
      meta.appendChild(el('span', null, formatDuration(task.duration)));
      meta.appendChild(el('span', null, 'Due ' + formatDeadline(d)));
      if (!task.done) {
        var rel = relativeDue(d);
        meta.appendChild(el('span', d.getTime() < Date.now() ? 'due-overdue' : null, rel));
      }
      main.appendChild(label);
      main.appendChild(meta);

      var edit = el('button', 'btn small', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', function () { startEdit(task.id); });

      li.appendChild(checkbox);
      li.appendChild(main);
      li.appendChild(edit);
      list.appendChild(li);
    });
  }

  function renderSchedule(res) {
    var body = $('schedule-body');
    var windowText = $('schedule-window');
    body.textContent = '';

    if (res.expired) {
      windowText.textContent = 'The plan window has ended.';
    } else {
      windowText.textContent = 'Plan for ' + plan.label + ': ' + formatTime(res.win.start) + ' to ' +
        formatTime(res.win.end) + ' (' + formatDuration(res.win.minutes) + ' available)';
    }

    if (!res.open.length) {
      body.appendChild(el('p', 'empty', 'No open tasks. Add a task, or mark one as not done, to build a schedule.'));
      return;
    }
    if (res.expired) {
      body.appendChild(el('p', 'empty', 'This plan window has ended. Send a new request in the chat, like "Plan my evening in 3 hours".'));
      return;
    }

    var timeline = el('ol', 'timeline');
    res.blocks.forEach(function (b) {
      var li = el('li', 'slot priority-' + b.task.priority);
      li.style.minHeight = Math.max(64, Math.round(b.minutes * PX_PER_MINUTE)) + 'px';

      var time = el('div', 'slot-time');
      time.appendChild(el('span', 'slot-start', formatTime(b.start)));
      time.appendChild(el('span', 'slot-end', 'until ' + formatTime(b.end)));

      var card = el('div', 'slot-card');
      card.appendChild(el('h3', 'slot-title', b.task.title));
      var meta = el('div', 'meta');
      meta.appendChild(priorityTag(b.task.priority));
      meta.appendChild(el('span', null, b.partial
        ? formatDuration(b.minutes) + ' of ' + formatDuration(b.task.duration)
        : formatDuration(b.minutes)));
      meta.appendChild(el('span', null, 'Due ' + formatDeadline(parseDeadline(b.task.deadline))));
      card.appendChild(meta);
      if (b.partial) {
        card.appendChild(el('p', 'flag', 'Partial session. Needs ' + formatDuration(b.needsMore) + ' more later.'));
      }
      if (b.late) {
        card.appendChild(el('p', 'flag warn', 'This block ends after the deadline.'));
      }

      li.appendChild(time);
      li.appendChild(card);
      timeline.appendChild(li);
    });

    if (res.freeMin > 0) {
      var freeStart = res.win.end - res.freeMin * 60000;
      var free = el('li', 'slot free');
      free.style.minHeight = Math.max(48, Math.round(res.freeMin * PX_PER_MINUTE)) + 'px';
      var freeTime = el('div', 'slot-time');
      freeTime.appendChild(el('span', 'slot-start', formatTime(freeStart)));
      freeTime.appendChild(el('span', 'slot-end', 'until ' + formatTime(res.win.end)));
      var freeCard = el('div', 'slot-card');
      freeCard.appendChild(el('h3', 'slot-title', 'Free time: ' + formatDuration(res.freeMin)));
      free.appendChild(freeTime);
      free.appendChild(freeCard);
      timeline.appendChild(free);
    }
    body.appendChild(timeline);

    if (res.skipped.length) {
      body.appendChild(el('h3', 'sub', 'Did not fit in this window'));
      var ul = el('ul', 'skipped');
      res.skipped.forEach(function (task) {
        var li = el('li');
        li.appendChild(el('strong', null, task.title));
        var meta = el('div', 'meta');
        meta.appendChild(priorityTag(task.priority));
        meta.appendChild(el('span', null, formatDuration(task.duration)));
        meta.appendChild(el('span', null, 'Due ' + formatDeadline(parseDeadline(task.deadline))));
        li.appendChild(meta);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
  }

  function renderAll() {
    var res = computeSchedule();
    renderStats(res);
    renderTasks();
    renderSchedule(res);
  }

  /* ---------- Task actions ---------- */

  async function toggleDone(id) {
    var task = findTask(id);
    if (!task) { return; }
    task.done = !task.done;
    saveTasks();
    if (mcpConnected) {
      try { await callMcpTool('set_task_status', { taskId: task.id, done: task.done }); }
      catch (error) { recordActivity('MCP status update failed', error.message); }
    }
    renderAll();
    var result = computeSchedule();
    addMessage('bot', task.done
      ? 'Marked "' + task.title + '" complete. I updated the task status and recalculated your remaining schedule. ' +
        (result.blocks.length ? 'Your next planned task is "' + result.blocks[0].task.title + '".' : 'There are no tasks scheduled in the current window.')
      : 'Reopened "' + task.title + '" and recalculated the schedule with it included again.');
  }

  function resetTaskForm() {
    $('task-form').reset();
    $('task-id').value = '';
    $('task-error').textContent = '';
    $('task-submit').textContent = 'Add task';
    $('task-cancel').hidden = true;
  }

  function startEdit(id) {
    var task = findTask(id);
    if (!task) { return; }
    $('task-id').value = task.id;
    $('task-title').value = task.title;
    $('task-deadline').value = task.deadline;
    $('task-duration').value = task.duration;
    $('task-priority').value = task.priority;
    $('task-error').textContent = '';
    $('task-submit').textContent = 'Save changes';
    $('task-cancel').hidden = false;
    $('task-title').focus();
  }

  async function handleTaskSubmit(event) {
    event.preventDefault();
    var id = $('task-id').value;
    var title = $('task-title').value.trim().replace(/\s+/g, ' ');
    var deadline = $('task-deadline').value;
    var durationText = $('task-duration').value.trim();
    var duration = Number(durationText);
    var priority = $('task-priority').value;
    var error = $('task-error');

    if (!title) {
      error.textContent = 'Enter a task name.';
      $('task-title').focus();
      return;
    }
    if (title.length > 80) {
      error.textContent = 'Keep the task name under 80 characters.';
      $('task-title').focus();
      return;
    }
    if (!parseDeadline(deadline)) {
      error.textContent = 'Pick a valid deadline date and time.';
      $('task-deadline').focus();
      return;
    }
    if (!durationText || !isFinite(duration) || Math.floor(duration) !== duration || duration < 5 || duration > 480) {
      error.textContent = 'Minutes needed must be a whole number from 5 to 480.';
      $('task-duration').focus();
      return;
    }
    if (!PRIORITY_WEIGHT[priority]) {
      error.textContent = 'Choose a priority.';
      $('task-priority').focus();
      return;
    }

    var existing = id ? findTask(id) : null;
    if (existing) {
      existing.title = title;
      existing.deadline = deadline;
      existing.duration = duration;
      existing.priority = priority;
    } else {
      tasks.push({ id: newId(), title: title, deadline: deadline, priority: priority, duration: duration, done: false });
    }

    saveTasks();
    var syncMessage = '';
    if (mcpConnected) {
      try {
        var synced = await syncTasksToMcp();
        syncMessage = ' The MCP server saved ' + synced.saved + ' tasks.';
      } catch (syncError) {
        recordActivity('MCP task sync failed', syncError.message);
        syncMessage = ' The server sync failed; this browser still has a local copy.';
      }
    }
    resetTaskForm();
    renderAll();
    addMessage('bot', (existing
      ? 'Updated "' + title + '". Your schedule has been recalculated using the new task details.'
      : 'Added "' + title + '". Your schedule has been recalculated with this task included.') + syncMessage);
  }

  /* ---------- Chat ---------- */

  function addMessage(role, text) {
    var log = $('chat-log');
    log.appendChild(el('div', 'msg ' + role, text));
    log.scrollTop = log.scrollHeight;
  }

  async function handleChatSubmit(event) {
    event.preventDefault();
    var input = $('chat-input');
    var text = input.value.trim();
    if (!text) {
      addMessage('bot', 'Type a request first, for example: "Plan my evening in 3 hours".');
      input.focus();
      return;
    }
    addMessage('user', text);
    input.value = '';

    if (/\b(what|which).*(first|next)|\bpriorit(y|ies|ize)\b|\bwhat should i do\b/i.test(text)) {
      var localResult = computeSchedule();
      var serverResult = null;
      if (mcpConnected) {
        try {
          var win = currentWindow();
          var available = win.minutes >= MIN_BLOCK ? win.minutes : 180;
          serverResult = await callMcpTool('plan_schedule', { minutes: available, startAt: new Date(win.minutes >= MIN_BLOCK ? win.start : Date.now()).toISOString() });
        } catch (error) { recordActivity('MCP planning failed', error.message); }
      }
      if (serverResult) {
        localResult = applyServerPlan(serverResult, localResult);
        renderStats(localResult);
        renderTasks();
        renderSchedule(localResult);
      }
      if (localResult.blocks.length) {
        var first = localResult.blocks[0];
        addMessage('bot', 'Start with "' + first.task.title + '". It is ' + whyFirst(first.task) + ' and fits first in your current plan.' +
          (serverResult ? '\nThe MCP planning tool checked ' + serverResult.openTaskCount + ' open tasks and allocated ' + serverResult.plannedTaskCount + ' blocks.' : ''));
      } else {
        var urgent = sortByUrgency(getOpen())[0];
        addMessage('bot', urgent ? 'I would start with "' + urgent.title + '" (' + whyFirst(urgent) + '). Send a time window to build a full schedule.' : 'You have no open tasks. Add a task to get a recommendation.');
      }
      return;
    }

    var parsed = parseRequest(text, new Date());
    if (parsed.error) {
      addMessage('bot', parsed.error + ' You can also ask "What should I do first?".');
      return;
    }
    plan = parsed.plan;
    var res = computeSchedule();
    renderAll();
    var serverPlan = null;
    if (mcpConnected) {
      try {
        serverPlan = await callMcpTool('plan_schedule', { minutes: plan.minutes, startAt: new Date(plan.start).toISOString() });
      } catch (error) {
        recordActivity('MCP planning failed', error.message);
      }
    }
    if (serverPlan) {
      res = applyServerPlan(serverPlan, res);
      renderStats(res);
      renderTasks();
      renderSchedule(res);
    }
    var response = summarize(res, parsed.note);
    if (serverPlan) {
      response += '\n\nMCP tool result: evaluated ' + serverPlan.openTaskCount + ' open tasks and allocated ' + serverPlan.plannedTaskCount + ' blocks on the server.';
    } else {
      response += '\n\nNote: MCP server is offline; this plan was generated locally in the browser.';
    }
    addMessage('bot', response);
  }

  /* ---------- Start ---------- */

  async function init() {
    plan = defaultPlan();
    $('task-form').addEventListener('submit', handleTaskSubmit);
    $('task-cancel').addEventListener('click', resetTaskForm);
    $('chat-form').addEventListener('submit', handleChatSubmit);
    Array.prototype.forEach.call(document.querySelectorAll('[data-request]'), function (button) {
      button.addEventListener('click', function () {
        $('chat-input').value = button.getAttribute('data-request');
        $('chat-form').requestSubmit();
      });
    });
    $('reset-demo').addEventListener('click', async function () {
      if (!window.confirm('Reset all tasks to the built-in demo list? Current task edits will be lost.')) return;
      try {
        if (mcpConnected) {
          var result = await callMcpTool('reset_demo_tasks', {});
          tasks = result.tasks;
        } else {
          tasks = sampleTasks();
          saveTasks();
        }
        plan = defaultPlan();
        renderAll();
        addMessage('bot', 'Demo tasks reset. I am ready to build a fresh plan.');
      } catch (error) {
        addMessage('bot', 'I could not reset the demo tasks: ' + error.message);
      }
    });

    var localTasks = loadTasks();
    tasks = localTasks === null ? sampleTasks() : localTasks;
    $('storage-warning').hidden = storageOk;
    setMcpStatus('', 'Connecting to MCP server');
    try {
      var serverState = await initializeMcpClient();
      if (serverState && Array.isArray(serverState.tasks)) {
        tasks = serverState.tasks;
        saveTasks();
      }
      addMessage('bot', 'Connected to the CampusPilot MCP server. I can read tasks, synchronize updates, and call the scheduling tool over Streamable HTTP. Tell me how much time you have.');
    } catch (error) {
      mcpConnected = false;
      setMcpStatus('offline', 'MCP server unavailable');
      recordActivity('Connection failed', error.message + ' Start the app with npm start to enable real MCP calls.');
      if (localTasks === null) saveTasks();
      addMessage('bot', 'The MCP server is not connected, so I am using the browser-only fallback. Start the app with npm start for live MCP tool calls.');
    }
    renderAll();
  }
  init();
})();
