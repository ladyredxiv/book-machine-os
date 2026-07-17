const http = require('http');

const HOLDFAST_URL = (process.env.HOLDFAST_URL || 'http://127.0.0.1:3217').replace(/\/+$/, '');
const SERVER_INFO = { name: 'holdfast-book-machine', version: '0.1.0' };

const tools = [
  {
    name: 'holdfast_health',
    description: 'Check whether the Holdfast desktop app API is reachable.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'holdfast_status',
    description: 'Get current project dashboard state, including chapters, flags, run monitor, and canon deltas.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional project id. If omitted, the active/first project is summarized.' }
      }
    }
  },
  {
    name: 'holdfast_context',
    description: 'Get curated writing context for a project/chapter from Holdfast.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: { type: 'string', enum: ['chapter', 'project', 'bible', 'metadata', 'revision'], default: 'chapter' },
        chapter: { type: ['number', 'string'] },
        includeText: { type: 'boolean', default: false },
        textLimit: { type: 'number', default: 5000 }
      }
    }
  },
  {
    name: 'holdfast_packet',
    description: 'Get the same chapter/session packet Holdfast uses for drafting, metadata, revision, or bible work.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        chapter: { type: ['number', 'string'] },
        intent: { type: 'string', default: 'draft' }
      }
    }
  },
  {
    name: 'holdfast_open_flags',
    description: 'List unresolved author questions/blockers for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } }
    }
  },
  {
    name: 'holdfast_pending_canon_deltas',
    description: 'List canon deltas still waiting for approval or resolution.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } }
    }
  },
  {
    name: 'holdfast_submit_chapter_metadata',
    description: 'Submit chapter metadata and canon deltas to Holdfast after drafting or editing a chapter.',
    inputSchema: {
      type: 'object',
      required: ['chapter', 'content'],
      properties: {
        projectId: { type: 'string' },
        chapter: { type: ['number', 'string'] },
        content: { type: 'object', description: 'Chapter metadata packet. May include canonDeltas and flags.' }
      }
    }
  },
  {
    name: 'holdfast_submit_canon_delta',
    description: 'Submit one proposed canon delta to Holdfast.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        projectId: { type: 'string' },
        chapter: { type: ['number', 'string'] },
        category: { type: 'string' },
        text: { type: 'string' },
        targetSection: { type: 'string' },
        applied: { type: 'boolean' },
        status: { type: 'string' }
      }
    }
  },
  {
    name: 'holdfast_review_canon_delta',
    description: 'Approve or reject a pending high-risk canon delta. Approval writes canon, updates status, and writes resume.signal.',
    inputSchema: {
      type: 'object',
      required: ['id', 'action'],
      properties: {
        projectId: { type: 'string' },
        id: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'reject'] }
      }
    }
  },
  {
    name: 'holdfast_create_project',
    description: 'Create a new Holdfast project using the app workflow, including acts and beat-map selection.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        premise: { type: 'string' },
        targetWords: { type: 'number' },
        chapters: { type: 'number' },
        beatMapType: { type: 'string', enum: ['horror', 'save-the-cat', 'custom'], default: 'horror' },
        customBeats: { type: 'string' },
        acts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              subtitle: { type: 'string' },
              start: { type: 'number' },
              end: { type: 'number' }
            }
          }
        }
      }
    }
  }
];

function textContent(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function sendMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function respond(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id, error) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: error && error.message ? error.message : String(error) }
  });
}

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, HOLDFAST_URL);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed && parsed.error ? parsed.error : `Holdfast returned ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', (error) => reject(new Error(`Holdfast API unreachable at ${HOLDFAST_URL}: ${error.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function query(params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
  });
  const text = q.toString();
  return text ? `?${text}` : '';
}

function pickProject(status, projectId) {
  const projects = status.projects || [];
  return projectId ? projects.find((project) => project.id === projectId) : projects[0];
}

async function callTool(name, args = {}) {
  if (name === 'holdfast_health') {
    return request('GET', '/api/health');
  }
  if (name === 'holdfast_status') {
    const status = await request('GET', '/api/status');
    const project = pickProject(status, args.projectId);
    return {
      root: status.root,
      mode: status.mode,
      selectedProject: project ? {
        id: project.id,
        title: project.config && project.config.title,
        words: project.metrics && project.metrics.words,
        draftedChapters: project.chapters && project.chapters.length,
        plannedChapters: project.config && project.config.chapters,
        openFlags: (project.flags || []).filter((flag) => !flag.done),
        pendingCanonDeltas: (project.canonDeltas || []).filter((delta) => !['accepted', 'rejected'].includes(delta.status)),
        nextMove: project.nextMove,
        runMonitor: project.runMonitor,
        chapterHealth: project.chapterHealth
      } : null,
      projects: (status.projects || []).map((item) => ({
        id: item.id,
        title: item.config && item.config.title,
        words: item.metrics && item.metrics.words,
        draftedChapters: item.chapters && item.chapters.length
      }))
    };
  }
  if (name === 'holdfast_context') {
    return request('GET', `/api/context${query(args)}`);
  }
  if (name === 'holdfast_packet') {
    return request('GET', `/api/packet${query(args)}`);
  }
  if (name === 'holdfast_open_flags') {
    const status = await request('GET', '/api/status');
    const project = pickProject(status, args.projectId);
    return { projectId: project && project.id, flags: project ? (project.flags || []).filter((flag) => !flag.done) : [] };
  }
  if (name === 'holdfast_pending_canon_deltas') {
    const result = await request('GET', `/api/canon-deltas${query({ projectId: args.projectId })}`);
    return { deltas: (result.deltas || []).filter((delta) => !['accepted', 'rejected'].includes(delta.status)) };
  }
  if (name === 'holdfast_submit_chapter_metadata') {
    return request('POST', '/api/chapter/meta/import', {
      projectId: args.projectId,
      chapter: args.chapter,
      content: args.content
    });
  }
  if (name === 'holdfast_submit_canon_delta') {
    return request('POST', '/api/canon-deltas', args);
  }
  if (name === 'holdfast_review_canon_delta') {
    return request('POST', '/api/canon-deltas/review', args);
  }
  if (name === 'holdfast_create_project') {
    return request('POST', '/api/project', args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  try {
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: message.params && message.params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    }
    if (message.method === 'tools/list') {
      respond(message.id, { tools });
      return;
    }
    if (message.method === 'tools/call') {
      const params = message.params || {};
      const result = await callTool(params.name, params.arguments || {});
      respond(message.id, { content: textContent(result) });
      return;
    }
    respondError(message.id, new Error(`Unsupported method: ${message.method}`));
  } catch (error) {
    respondError(message.id, error);
  }
}

let buffer = Buffer.alloc(0);

function tryParseMessages() {
  while (buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.slice(bodyEnd);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      process.stderr.write(`Invalid MCP message: ${error.message}\n`);
    }
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryParseMessages();
});

process.stdin.on('end', () => process.exit(0));
