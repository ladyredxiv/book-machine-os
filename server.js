const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const childProcess = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const REPO_MODE = Boolean(process.env.REPO_PATH);
const ROOT = process.env.REPO_PATH || process.env.HOLDFAST_LIBRARY || path.join(__dirname, 'library');
const PROJECTS_ROOT = REPO_MODE ? ROOT : path.join(ROOT, 'projects');
const PUBLIC = path.join(__dirname, 'public');
const STAGES = ['planned', 'drafting', 'self-edit', 'review', 'final'];
const COVER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const LOOSE_DOCX_PREFIX = '__loose_docx__';
const CONFIG_PATH = process.env.HOLDFAST_CONFIG_PATH || path.join(__dirname, 'config', 'holdfast.env');
const SETTINGS_PATH = process.env.HOLDFAST_SETTINGS_PATH || path.join(path.dirname(CONFIG_PATH), 'settings.json');
const VIRTUAL_PROJECT_PREFIX = '__pen_projects__';
const notifiedFlags = new Set();
const webSessions = new Map();
const mcpEvents = [];
const claudeJobs = new Map();
let notifyTimer = null;
let openRouterModelCache = null;
let openRouterModelCacheAt = 0;
const DEFAULT_PEN_NAME = 'Primary Pen';
const RETIRED_PEN_NAMES = new Set(['R.A. Lorne']);
const MCP_SERVER_INFO = { name: 'holdfast-book-machine', version: '0.2.0' };
const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slugify(value) {
  return String(value || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled';
}

function safeFileName(value, fallback = 'story-bible') {
  const ext = path.extname(String(value || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const base = path.basename(String(value || fallback), path.extname(String(value || '')))
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || fallback;
  return `${base}${ext || ''}`;
}

const BEAT_ANCHORS = [
  ['Opening Image', 0],
  ['Theme Stated', 5],
  ['Set-up', 8],
  ['Catalyst', 11],
  ['Debate', 16],
  ['Break Into Two', 21],
  ['B Story', 24],
  ['Fun and Games', 35],
  ['Midpoint', 50],
  ['Bad Guys Close In', 60],
  ['All Is Lost', 75],
  ['Dark Night of the Soul', 78],
  ['Break Into Three', 81],
  ['Finale', 90],
  ['Final Image', 100]
];

const HORROR_BEAT_ANCHORS = [
  ['The World is Not What it Seems', 0],
  ['Putting the Players in Action', 7],
  ['Setting them on the Path', 14],
  ['The Warning', 20],
  ['The First Contact with the Monster', 27],
  ['Shit Gets Real', 34],
  ['The Chase', 43],
  ['Failed Confrontation', 52],
  ['The Darkest Hour', 62],
  ['A Different Solution', 70],
  ['Seeking Out the Beast', 77],
  ['The True Cost is Revealed', 84],
  ['Sacrifices Are Made (or not)', 90],
  ['The Inevitable Fall Out', 96],
  ['Evil Cannot Be Conquered, Only Delayed', 100]
];

function generateAnchoredBeats(totalChapters, anchors) {
  const total = Math.max(1, Math.min(120, Number(totalChapters || 30)));
  const span = Math.max(total - 1, 1);
  const beats = {};
  let lastBeat = null;
  for (let chapter = 1; chapter <= total; chapter += 1) {
    const pct = ((chapter - 1) / span) * 100;
    let bestName = anchors[0][0];
    let bestDist = Infinity;
    anchors.forEach(([name, anchor]) => {
      const dist = Math.abs(pct - anchor);
      if (dist < bestDist) {
        bestName = name;
        bestDist = dist;
      }
    });
    beats[String(chapter)] = bestName === lastBeat ? `${bestName} (continued)` : bestName;
    lastBeat = bestName;
  }
  return beats;
}

function generateSaveTheCatBeats(totalChapters) {
  return generateAnchoredBeats(totalChapters, BEAT_ANCHORS);
}

function generateHorrorBeats(totalChapters) {
  return generateAnchoredBeats(totalChapters, HORROR_BEAT_ANCHORS);
}

function normalizeCustomBeats(customBeats, totalChapters) {
  if (!customBeats) return null;
  let parsed = customBeats;
  if (typeof customBeats === 'string') {
    const text = customBeats.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      parsed = {};
      lines.forEach((line) => {
        const match = line.match(/^(?:ch(?:apter)?\.?\s*)?(\d+)\s*[:\-–—]\s*(.+)$/i);
        if (match) parsed[String(Number(match[1]))] = normalizeText(match[2]).trim();
      });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const total = Math.max(1, Math.min(120, Number(totalChapters || 30)));
  const beats = {};
  for (let chapter = 1; chapter <= total; chapter += 1) {
    beats[String(chapter)] = normalizeText(parsed[String(chapter)] || parsed[chapter] || '').trim();
  }
  return beats;
}

function defaultActs(totalChapters) {
  const total = Math.max(1, Math.min(120, Number(totalChapters || 30)));
  const oneEnd = Math.max(1, Math.round(total * 0.27));
  const twoEnd = Math.max(oneEnd + 1, Math.round(total * 0.73));
  return [
    { name: 'Act One', subtitle: 'Opening movement', start: 1, end: oneEnd },
    { name: 'Act Two', subtitle: 'Middle movement', start: oneEnd + 1, end: Math.min(twoEnd, total) },
    { name: 'Act Three', subtitle: 'Closing movement', start: Math.min(twoEnd + 1, total), end: total }
  ].filter((act) => act.start <= act.end);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseEnvText(text) {
  return String(text || '').split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return env;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return env;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
    return env;
  }, {});
}

function readEnvConfig() {
  return fs.existsSync(CONFIG_PATH) ? parseEnvText(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
}

function envValue(key) {
  const fileConfig = readEnvConfig();
  return fileConfig[key] || process.env[key] || '';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterations, salt, expected] = parts;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

function writeEnvConfig(patch) {
  const current = {
    PORT: String(process.env.PORT || PORT || 3000),
    REPO_PATH: process.env.REPO_PATH || '',
    HOLDFAST_LIBRARY: process.env.HOLDFAST_LIBRARY || '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN || '',
    MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL || '',
    CLAUDE_COMMAND: process.env.CLAUDE_COMMAND || '',
    CLAUDE_ARGS_TEMPLATE: process.env.CLAUDE_ARGS_TEMPLATE || '',
    WEB_AUTH_EMAIL: process.env.WEB_AUTH_EMAIL || '',
    WEB_AUTH_PASSWORD_HASH: process.env.WEB_AUTH_PASSWORD_HASH || '',
    ...readEnvConfig()
  };
  ['PORT', 'REPO_PATH', 'HOLDFAST_LIBRARY'].forEach((key) => {
    if (patch[key] !== undefined) current[key] = normalizeText(patch[key]).trim();
  });
  ['DISCORD_WEBHOOK_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'MCP_AUTH_TOKEN'].forEach((key) => {
    if (patch[key] !== undefined && String(patch[key]).trim()) current[key] = String(patch[key]).trim();
  });
  if (patch.MCP_PUBLIC_URL !== undefined) current.MCP_PUBLIC_URL = normalizeText(patch.MCP_PUBLIC_URL).trim();
  if (patch.CLAUDE_COMMAND !== undefined) current.CLAUDE_COMMAND = normalizeText(patch.CLAUDE_COMMAND).trim();
  if (patch.CLAUDE_ARGS_TEMPLATE !== undefined) current.CLAUDE_ARGS_TEMPLATE = normalizeText(patch.CLAUDE_ARGS_TEMPLATE).trim();
  if (patch.WEB_AUTH_EMAIL !== undefined) current.WEB_AUTH_EMAIL = normalizeText(patch.WEB_AUTH_EMAIL).trim().toLowerCase();
  if (patch.WEB_AUTH_PASSWORD !== undefined && String(patch.WEB_AUTH_PASSWORD).trim()) {
    current.WEB_AUTH_PASSWORD_HASH = hashPassword(String(patch.WEB_AUTH_PASSWORD));
  }
  ensureDir(path.dirname(CONFIG_PATH));
  const lines = [
    '# Holdfast Book Machine local config',
    '# Restart the desktop app after changing PORT, REPO_PATH, or HOLDFAST_LIBRARY.',
    `PORT=${current.PORT || ''}`,
    `REPO_PATH=${current.REPO_PATH || ''}`,
    `HOLDFAST_LIBRARY=${current.HOLDFAST_LIBRARY || ''}`,
    `DISCORD_WEBHOOK_URL=${current.DISCORD_WEBHOOK_URL || ''}`,
    `ANTHROPIC_API_KEY=${current.ANTHROPIC_API_KEY || ''}`,
    `OPENAI_API_KEY=${current.OPENAI_API_KEY || ''}`,
    `OPENROUTER_API_KEY=${current.OPENROUTER_API_KEY || ''}`,
    `MCP_AUTH_TOKEN=${current.MCP_AUTH_TOKEN || ''}`,
    `MCP_PUBLIC_URL=${current.MCP_PUBLIC_URL || ''}`,
    `CLAUDE_COMMAND=${current.CLAUDE_COMMAND || ''}`,
    `CLAUDE_ARGS_TEMPLATE=${current.CLAUDE_ARGS_TEMPLATE || ''}`,
    `WEB_AUTH_EMAIL=${current.WEB_AUTH_EMAIL || ''}`,
    `WEB_AUTH_PASSWORD_HASH=${current.WEB_AUTH_PASSWORD_HASH || ''}`,
    ''
  ];
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf8');
  Object.entries(current).forEach(([key, value]) => { process.env[key] = value || ''; });
  return getAppConfig();
}

function getAppConfig() {
  const fileConfig = readEnvConfig();
  const resourceRoot = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'mcp-server.js')) ? process.resourcesPath : __dirname;
  return {
    configPath: CONFIG_PATH,
    settingsPath: SETTINGS_PATH,
    port: fileConfig.PORT || process.env.PORT || String(PORT),
    repoPath: fileConfig.REPO_PATH || process.env.REPO_PATH || '',
    holdfastLibrary: fileConfig.HOLDFAST_LIBRARY || process.env.HOLDFAST_LIBRARY || '',
    activeRoot: ROOT,
    mcpServerPath: path.join(resourceRoot, 'mcp-server.js'),
    mcpHoldfastUrl: `http://127.0.0.1:${fileConfig.PORT || process.env.PORT || String(PORT)}`,
    mcpRemoteUrl: `http://localhost:${fileConfig.PORT || process.env.PORT || String(PORT)}/mcp`,
    mcpPublicUrl: fileConfig.MCP_PUBLIC_URL || process.env.MCP_PUBLIC_URL || '',
    claudeCommand: fileConfig.CLAUDE_COMMAND || process.env.CLAUDE_COMMAND || 'claude',
    claudeArgsTemplate: fileConfig.CLAUDE_ARGS_TEMPLATE || process.env.CLAUDE_ARGS_TEMPLATE || '-p {prompt}',
    webAuthEmail: fileConfig.WEB_AUTH_EMAIL || process.env.WEB_AUTH_EMAIL || '',
    restartNeededForPaths: true,
    secrets: {
      discord: Boolean(fileConfig.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL),
      anthropic: Boolean(fileConfig.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
      openai: Boolean(fileConfig.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
      openrouter: Boolean(fileConfig.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY),
      mcpAuth: Boolean(fileConfig.MCP_AUTH_TOKEN || process.env.MCP_AUTH_TOKEN),
      webAuth: Boolean((fileConfig.WEB_AUTH_EMAIL || process.env.WEB_AUTH_EMAIL) && (fileConfig.WEB_AUTH_PASSWORD_HASH || process.env.WEB_AUTH_PASSWORD_HASH))
    }
  };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/â€”/g, '-')
    .replace(/â€“/g, '-')
    .replace(/â€˜|â€™/g, "'")
    .replace(/â€œ|â€/g, '"')
    .replace(/â€¦/g, '...');
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function stripStatus(text) {
  return String(text || '').replace(/^STATUS:\s*.*\r?\n\r?\n?/i, '');
}

function statusFrom(text, fallback = 'planned') {
  const match = String(text || '').match(/^STATUS:\s*([a-z-]+)/im);
  if (!match) return fallback;
  const value = match[1].toLowerCase();
  const aliases = {
    'drafted-self-edited': 'review',
    'needs-human-review': 'review',
    'revision-needed': 'review',
    drafted: 'review',
    complete: 'review'
  };
  const normalized = aliases[value] || value;
  return STAGES.includes(normalized) ? normalized : fallback;
}

function totalChapters(config) {
  const explicit = Number(config && config.chapters || 0);
  const acts = Array.isArray(config && config.acts) ? config.acts : [];
  const actEnd = acts.reduce((max, act) => Math.max(max, Number(act.end || 0)), 0);
  return Math.max(explicit, actEnd, 0);
}

function safeJoin(root, relativePath = '') {
  const normalized = path.normalize(String(relativePath).replace(/^[/\\]+/, ''));
  const full = path.resolve(root, normalized);
  const safeRoot = path.resolve(root);
  if (full !== safeRoot && !full.startsWith(safeRoot + path.sep)) {
    throw new Error('Path is outside the library');
  }
  return full;
}

function send(res, status, data, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function webAuthConfigured() {
  return Boolean(envValue('WEB_AUTH_EMAIL') && envValue('WEB_AUTH_PASSWORD_HASH'));
}

function webRequestAuthorized(req) {
  if (!webAuthConfigured() || isLocalRequest(req)) return true;
  const sessionId = parseCookies(req).holdfast_session;
  if (!sessionId) return false;
  const session = webSessions.get(sessionId);
  if (!session || session.expires < Date.now()) {
    webSessions.delete(sessionId);
    return false;
  }
  session.expires = Date.now() + 12 * 60 * 60 * 1000;
  return session.email === envValue('WEB_AUTH_EMAIL').toLowerCase();
}

function setSessionCookie(req, res, sessionId) {
  const secure = !isLocalRequest(req) || String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie', `holdfast_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'holdfast_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function loginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Book Machine Login</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171513;color:#f7f0e5;font-family:Inter,Segoe UI,sans-serif}
form{width:min(420px,calc(100vw - 32px));background:#24211d;border:1px solid #4b4338;border-radius:10px;padding:24px}
h1{font-size:22px;margin:0 0 6px}p{color:#bcae9d;line-height:1.45}label{display:block;margin-top:14px;font-size:13px;color:#d0c2b0}
input{width:100%;box-sizing:border-box;margin-top:6px;border:1px solid #4b4338;border-radius:7px;background:#181613;color:#f7f0e5;padding:10px}
button{margin-top:18px;width:100%;border:0;border-radius:7px;background:#d78a43;color:#17100a;font-weight:700;padding:10px;cursor:pointer}.error{color:#ffb6a3}
</style></head><body><form method="post" action="/login"><h1>Book Machine OS</h1><p>Sign in to access your private manuscript library.</p>${error ? `<p class="error">${escapeHtml(normalizeText(error))}</p>` : ''}<label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign In</button></form></body></html>`;
}

function parseForm(raw) {
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function initLibrary() {
  ensureDir(ROOT);
  ensureDir(path.dirname(SETTINGS_PATH));
  const legacySettingsPath = path.join(ROOT, 'settings.json');
  if (!fs.existsSync(SETTINGS_PATH) && !fs.existsSync(legacySettingsPath)) {
    writeJson(SETTINGS_PATH, {
      author: DEFAULT_PEN_NAME,
      machineName: 'Book Machine OS',
      penNames: [DEFAULT_PEN_NAME],
      penProfiles: [{ name: DEFAULT_PEN_NAME, repoPath: '' }],
      looseLibraries: [],
      defaultTargetWords: 90000,
      defaultChapters: 30
    });
  }
  if (REPO_MODE) return;
  const projects = getProjects();
  if (!projects.length) {
    createProject({
      title: 'First Book',
      premise: 'A working book project. Rename this, add your premise, and start drafting.',
      targetWords: 90000,
      chapters: 30
    });
  }
}

function getSettings() {
  const fallback = {
    author: DEFAULT_PEN_NAME,
    machineName: 'Book Machine OS',
    penNames: [DEFAULT_PEN_NAME],
    penProfiles: [{ name: DEFAULT_PEN_NAME, repoPath: '' }],
    looseLibraries: [],
    defaultTargetWords: 90000,
    defaultChapters: 30
  };
  const legacySettingsPath = path.join(ROOT, 'settings.json');
  const settings = readJson(SETTINGS_PATH, null) || readJson(legacySettingsPath, fallback);
  settings.author = activePenName(settings.author, fallback.author);
  settings.machineName = settings.machineName || fallback.machineName;
  settings.penNames = Array.from(new Set([settings.author, ...(Array.isArray(settings.penNames) ? settings.penNames : [])]
    .map((name) => activePenName(name, ''))
    .filter(Boolean)));
  const profileMap = new Map();
  (Array.isArray(settings.penProfiles) ? settings.penProfiles : []).forEach((profile) => {
    const name = activePenName(profile && profile.name, '');
    if (name) profileMap.set(name, { name, repoPath: normalizeText(profile.repoPath || profile.rootPath || '').trim() });
  });
  settings.penNames.forEach((name) => {
    if (!profileMap.has(name)) profileMap.set(name, { name, repoPath: '' });
  });
  settings.penProfiles = Array.from(profileMap.values());
  settings.looseLibraries = (Array.isArray(settings.looseLibraries) ? settings.looseLibraries : [])
    .map((item) => ({
      penName: activePenName(item && (item.penName || item.name || item.author), settings.author),
      path: normalizeText(item && (item.path || item.rootPath || item.repoPath)).trim()
    }))
    .filter((item) => item.path);
  return settings;
}

function updateSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  if (patch.machineName !== undefined) next.machineName = normalizeText(patch.machineName).trim() || current.machineName;
  if (patch.author !== undefined) next.author = activePenName(patch.author, current.author);
  if (patch.penNames !== undefined) {
    const names = Array.isArray(patch.penNames) ? patch.penNames : String(patch.penNames || '').split(/\r?\n|,/);
    next.penNames = Array.from(new Set([next.author, ...names.map((name) => activePenName(name, '')).filter(Boolean)]));
  } else {
    next.penNames = Array.from(new Set([next.author, ...(next.penNames || []).map((name) => activePenName(name, '')).filter(Boolean)]));
  }
  if (patch.penProfiles !== undefined) {
    const profiles = Array.isArray(patch.penProfiles) ? patch.penProfiles : [];
    const profileMap = new Map();
    profiles.forEach((profile) => {
      const name = activePenName(profile && profile.name, '');
      if (name) profileMap.set(name, { name, repoPath: normalizeText(profile.repoPath || profile.rootPath || '').trim() });
    });
    next.penNames.forEach((name) => {
      if (!profileMap.has(name)) profileMap.set(name, { name, repoPath: '' });
    });
    next.penProfiles = Array.from(profileMap.values());
  } else {
    next.penProfiles = getSettings().penProfiles.map((profile) => ({ ...profile }));
    next.penNames.forEach((name) => {
      if (!next.penProfiles.some((profile) => profile.name === name)) next.penProfiles.push({ name, repoPath: '' });
    });
  }
  if (patch.looseLibraries !== undefined) {
    next.looseLibraries = (Array.isArray(patch.looseLibraries) ? patch.looseLibraries : [])
      .map((item) => ({
        penName: activePenName(item && (item.penName || item.name || item.author), next.author),
        path: normalizeText(item && (item.path || item.rootPath || item.repoPath)).trim()
      }))
      .filter((item) => item.path);
  }
  writeJson(SETTINGS_PATH, next);
  return next;
}

function isRetiredPenName(name) {
  return RETIRED_PEN_NAMES.has(normalizeText(name).trim());
}

function activePenName(name, fallback = DEFAULT_PEN_NAME) {
  const cleaned = normalizeText(name).trim();
  return cleaned && !isRetiredPenName(cleaned) ? cleaned : fallback;
}

function projectRoots() {
  const roots = [PROJECTS_ROOT];
  getSettings().penProfiles.forEach((profile) => {
    if (profile.repoPath) roots.push(path.resolve(profile.repoPath));
  });
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function projectRootForPen(penName) {
  const settings = getSettings();
  const profile = settings.penProfiles.find((item) => item.name === penName);
  return profile && profile.repoPath ? path.resolve(profile.repoPath) : PROJECTS_ROOT;
}

function penNameForProjectRoot(root) {
  const resolved = path.resolve(root);
  const settings = getSettings();
  const profile = settings.penProfiles.find((item) => item.repoPath && path.resolve(item.repoPath) === resolved);
  if (profile) return profile.name;
  return '';
}

function projectDir(id, penName = '') {
  if (penName) return safeJoin(projectRootForPen(penName), id);
  const found = projectRoots()
    .map((root) => safeJoin(root, id))
    .find((dir) => fs.existsSync(path.join(dir, 'project.json')));
  return found || safeJoin(PROJECTS_ROOT, id);
}

function configPath(id, penName = '') {
  return path.join(projectDir(id, penName), 'project.json');
}

function addLog(projectId, type, text) {
  const file = path.join(projectDir(projectId), 'sessions', 'progress.md');
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `LOG|${nowStamp()}|${type}|${normalizeText(text)}\n`, 'utf8');
}

function flagKey(projectId, text) {
  return `${projectId}::${normalizeText(text).trim().toLowerCase()}`;
}

function sendDiscordNotification(projectTitle, flagText) {
  const webhookUrl = envValue('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) return;
  try {
    const https = require('https');
    const payload = JSON.stringify({
      embeds: [{
        title: 'Flag: waiting on your input',
        description: normalizeText(flagText).slice(0, 3900),
        color: 0xC17D2A,
        fields: [{ name: 'Project', value: normalizeText(projectTitle || 'Untitled'), inline: true }],
        footer: { text: 'Holdfast Book Machine' },
        timestamp: new Date().toISOString()
      }]
    });
    const webhook = new URL(webhookUrl);
    const req = https.request({
      hostname: webhook.hostname,
      path: webhook.pathname + webhook.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => res.on('data', () => {}));
    req.on('error', (error) => console.log('Discord notification failed:', error.message));
    req.write(payload);
    req.end();
  } catch (error) {
    console.log('Discord notification error:', error.message);
  }
}

function notifyForFlag(projectId, projectTitle, text) {
  const cleaned = normalizeText(text).trim();
  if (!cleaned) return;
  const key = flagKey(projectId, cleaned);
  if (notifiedFlags.has(key)) return;
  notifiedFlags.add(key);
  sendDiscordNotification(projectTitle, cleaned);
}

function seedExistingFlags() {
  getProjects().forEach((project) => {
    project.flags.filter((flag) => !flag.done).forEach((flag) => notifiedFlags.add(flagKey(project.id, flag.text)));
  });
}

function scanForNewFlags() {
  getProjects().forEach((project) => {
    project.flags.filter((flag) => !flag.done).forEach((flag) => notifyForFlag(project.id, project.config.title, flag.text));
  });
}

function createProject(input) {
  const settings = getSettings();
  const title = String(input.title || 'Untitled Book').trim();
  const penName = normalizeText(input.penName || settings.author || DEFAULT_PEN_NAME).trim();
  let id = slugify(input.id || title);
  const base = id;
  let n = 2;
  while (fs.existsSync(projectDir(id, penName))) {
    id = `${base}-${n++}`;
  }

  const dir = projectDir(id, penName);
  ['manuscript', 'characters', 'sessions', 'worldbuilding', 'outlines', 'exports'].forEach((name) => ensureDir(path.join(dir, name)));

  const chapters = Math.max(1, Math.min(120, Number(input.chapters || 30)));
  const acts = Array.isArray(input.acts) && input.acts.length
    ? input.acts.map((act) => ({
      name: normalizeText(act.name || '').trim() || 'Act',
      subtitle: normalizeText(act.subtitle || '').trim(),
      start: Math.max(1, Number(act.start || 1)),
      end: Math.max(1, Number(act.end || chapters))
    })).filter((act) => act.start <= act.end).sort((a, b) => a.start - b.start)
    : defaultActs(chapters);
  const finalChapter = acts.length ? acts[acts.length - 1].end : chapters;
  const beatMapType = String(input.beatMapType || 'save-the-cat');
  const customBeats = normalizeCustomBeats(input.customBeats || input.beats, finalChapter);
  const config = {
    id,
    title,
    penName,
    status: 'active',
    premise: String(input.premise || ''),
    targetWords: Number(input.targetWords || 90000),
    createdAt: new Date().toISOString(),
    chapters: finalChapter,
    acts,
    beatMapType,
    beats: customBeats || (beatMapType === 'horror' ? generateHorrorBeats(finalChapter) : generateSaveTheCatBeats(finalChapter))
  };

  writeJson(configPath(id, penName), config);
  ['manuscript', 'characters', 'sessions', 'worldbuilding', 'outlines'].forEach((name) => {
    fs.writeFileSync(path.join(dir, name, 'placeholder.md'), `# ${title} - ${name}\n\nPlaceholder. Replace with content.\n`, 'utf8');
  });
  fs.writeFileSync(path.join(dir, 'outlines', 'book-outline.md'), `# ${title}\n\n## Premise\n${config.premise}\n\n## Acts\n${acts.map((act) => `- ${act.name}: ${act.subtitle} (Ch. ${act.start}-${act.end})`).join('\n')}\n\n## Beat Map\n${Object.entries(config.beats).map(([chapter, beat]) => `- Chapter ${chapter}: ${beat}`).join('\n')}\n`, 'utf8');
  let bibleImport = null;
  if (input.storyBible && input.storyBible.content) {
    const originalName = safeFileName(input.storyBible.name || 'story-bible.docx', 'story-bible');
    const targetName = /^holdfast_bible\./i.test(originalName) ? originalName : `holdfast_bible${path.extname(originalName) || '.docx'}`;
    const targetFile = path.join(dir, targetName);
    fs.writeFileSync(targetFile, Buffer.from(String(input.storyBible.content), 'base64'));
    bibleImport = { fileName: targetName, path: targetFile };
  }
  addLog(id, 'create', 'Project created');
  if (bibleImport) addLog(id, 'bible', `Imported starting story bible ${bibleImport.fileName}`);
  let commit = { attempted: false, ok: false, message: 'Git commit skipped' };
  if (input.commit !== false) {
    try {
      commitProject(id, `Initialize ${title} project`);
      commit = { attempted: true, ok: true, message: 'Project committed' };
    } catch (error) {
      commit = { attempted: true, ok: false, message: error.message };
    }
  }
  const project = getProject(id);
  project.creation = { commit, beatMapType: customBeats ? 'custom' : beatMapType, folders: ['manuscript', 'characters', 'sessions', 'worldbuilding', 'outlines'], bibleImport };
  return project;
}

function listMarkdownFiles(dir, projectId, bucket) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /\.(md|txt)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({
      name,
      path: projectFilePath(projectId, bucket, name),
      bucket
    }));
}

function projectFilePathFromRelative(projectId, relativePath) {
  const dir = path.resolve(projectDir(projectId));
  const defaultRoot = path.resolve(PROJECTS_ROOT);
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (path.dirname(dir) === defaultRoot) {
    return REPO_MODE ? `${projectId}/${clean}` : `projects/${projectId}/${clean}`;
  }
  return `${VIRTUAL_PROJECT_PREFIX}/${projectId}/${clean}`;
}

function projectFilePath(projectId, bucket, name) {
  return projectFilePathFromRelative(projectId, `${bucket}/${name}`);
}

function resolveRelativeFile(relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.startsWith(`${LOOSE_DOCX_PREFIX}/`)) {
    throw new Error('Loose DOCX files are read-only');
  }
  if (clean.startsWith(`${VIRTUAL_PROJECT_PREFIX}/`)) {
    const parts = clean.split('/');
    const projectId = parts[1];
    const rest = parts.slice(2).join('/');
    return safeJoin(projectDir(projectId), rest);
  }
  return safeJoin(ROOT, clean);
}

function readZipEntry(zipPath, wantedName) {
  const buffer = fs.readFileSync(zipPath);
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (name === wantedName) {
      const raw = buffer.slice(dataStart, dataEnd);
      if (method === 0) return raw.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8');
      throw new Error('Unsupported DOCX compression method');
    }
    offset = dataEnd;
  }
  throw new Error(`DOCX entry not found: ${wantedName}`);
}

function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const raw = buffer.slice(dataStart, dataEnd);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) entries.push({ name, data });
    offset = dataEnd;
  }
  return entries;
}

function paragraphTextFromXml(pXml) {
  return (pXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
    .map((part) => {
      if (part.startsWith('<w:tab')) return '\t';
      if (part.startsWith('<w:br')) return '\n';
      const match = part.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
      return match ? decodeXml(match[1]) : '';
    })
    .join('');
}

function paragraphStyleFromXml(pXml) {
  const match = pXml.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
  if (!match) return '';
  const value = match[1];
  if (/^Heading(\d+)$/i.test(value)) return `Heading ${value.match(/\d+/)[0]}`;
  return value;
}

function parseDocxParagraphs(file) {
  const xml = readZipEntry(file, 'word/document.xml');
  return (xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [])
    .map((pXml, index) => ({
      index,
      style: paragraphStyleFromXml(pXml),
      text: normalizeText(paragraphTextFromXml(pXml)).trim()
    }))
    .filter((paragraph) => paragraph.text);
}

function looseLibraryRoots() {
  return getSettings().looseLibraries
    .map((library) => ({ penName: library.penName || getSettings().author || DEFAULT_PEN_NAME, root: path.resolve(library.path) }))
    .filter((library) => library.root && fs.existsSync(library.root));
}

function looseIdForDir(dir) {
  return `docx-${crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 14)}`;
}

function titleFromFolder(dir) {
  return path.basename(dir).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looseManifestPath() {
  return path.join(path.dirname(SETTINGS_PATH), 'loose-docx-manuscripts.json');
}

function getLooseManifest() {
  return readJson(looseManifestPath(), {});
}

function saveLooseManifest(manifest) {
  writeJson(looseManifestPath(), manifest || {});
}

function looseAllowedDir(dir) {
  const resolved = path.resolve(dir);
  return looseLibraryRoots().some((library) => resolved === library.root || resolved.startsWith(library.root + path.sep));
}

function versionScore(file) {
  const name = path.basename(file).toLowerCase();
  let score = 0;
  if (/\bfinal\b/.test(name)) score += 30;
  if (/\bmerged\b/.test(name)) score += 24;
  if (/revised|revision/.test(name)) score += 16;
  if (/post[-_\s]?sweep/.test(name)) score += 14;
  if (/editorial|restored/.test(name)) score += 8;
  if (/manuscript|complete|latest/.test(name)) score += 8;
  if (/backup|old|copy|conflict|autosave|digest|print|paperback|ebook|epub/.test(name)) score -= 30;
  return score;
}

function coverScore(file) {
  const name = path.basename(file).toLowerCase();
  let score = 0;
  if (name.includes('cover')) score += 20;
  if (name.includes('ku')) score += 8;
  if (name.includes('paperback')) score -= 6;
  if (name.includes('test')) score -= 4;
  if (name.endsWith('.png')) score += 2;
  return score;
}

function walkLooseBookDirs(root, maxDepth = 3) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasDocx = entries.some((entry) => entry.isFile() && /\.docx$/i.test(entry.name) && !entry.name.startsWith('~$'));
    if (hasDocx) found.push(dir);
    entries
      .filter((entry) => entry.isDirectory() && !/^\./.test(entry.name))
      .forEach((entry) => visit(path.join(dir, entry.name), depth + 1));
  };
  visit(root, 0);
  return found;
}

function listLooseVersions(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.docx$/i.test(entry.name) && !entry.name.startsWith('~$'))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      return {
        fileName: entry.name,
        path: file,
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
        score: versionScore(file)
      };
    })
    .sort((a, b) => b.score - a.score || new Date(b.modifiedAt) - new Date(a.modifiedAt) || a.fileName.localeCompare(b.fileName));
}

function findLooseCover(dir) {
  if (!fs.existsSync(dir)) return null;
  const covers = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && COVER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, path: file, score: coverScore(file), mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return covers[0] || null;
}

function parseLooseDocxChapters(file) {
  const paragraphs = parseDocxParagraphs(file);
  const starts = [];
  paragraphs.forEach((paragraph, index) => {
    const text = paragraph.text.trim();
    if (/^(prologue|epilogue|chapter\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|ch\.?\s*\d+\b)/i.test(text)) {
      starts.push({ index, title: text });
    }
  });
  if (!starts.length) starts.push({ index: 0, title: 'Manuscript' });
  return starts.map((start, index) => {
    const end = starts[index + 1] ? starts[index + 1].index : paragraphs.length;
    const slice = paragraphs.slice(start.index, end);
    const text = slice.map((paragraph, paragraphIndex) => {
      if (paragraphIndex === 0) return `# ${paragraph.text}`;
      return paragraph.text;
    }).join('\n\n');
    return {
      num: index + 1,
      file: `chapter-${String(index + 1).padStart(2, '0')}.md`,
      title: start.title,
      text,
      words: wordCount(text)
    };
  });
}

function looseChapterPath(projectId, versionIndex, chapterNumber) {
  return `${LOOSE_DOCX_PREFIX}/${projectId}/${versionIndex}/chapter-${String(chapterNumber).padStart(3, '0')}.md`;
}

function getLooseProjects() {
  const manifest = getLooseManifest();
  return looseLibraryRoots().flatMap((library) => walkLooseBookDirs(library.root).map((dir) => {
    const id = looseIdForDir(dir);
    const versions = listLooseVersions(dir);
    if (!versions.length) return null;
    const pinned = manifest[id] && manifest[id].preferredVersion;
    const selectedIndex = Math.max(0, versions.findIndex((version) => version.fileName === pinned));
    const selected = versions[selectedIndex] || versions[0];
    let chapters = [];
    try {
      chapters = parseLooseDocxChapters(selected.path).map((chapter) => ({
        ...chapter,
        path: looseChapterPath(id, selectedIndex, chapter.num),
        beat: selected.fileName,
        status: 'read-only',
        updatedAt: selected.modifiedAt
      }));
    } catch {
      chapters = [{
        num: 1,
        file: selected.fileName,
        path: looseChapterPath(id, selectedIndex, 1),
        title: selected.fileName.replace(/\.docx$/i, ''),
        beat: selected.fileName,
        status: 'read-only',
        words: 0,
        updatedAt: selected.modifiedAt
      }];
    }
    const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
    const cover = findLooseCover(dir);
    return {
      id,
      kind: 'loose-docx',
      config: {
        title: manifest[id] && manifest[id].title || titleFromFolder(dir),
        penName: library.penName,
        status: 'read-only',
        chapters: chapters.length
      },
      chapters,
      planned: [],
      files: { manuscript: versions.map((version, index) => ({ name: version.fileName, path: looseChapterPath(id, index, 1), bucket: 'manuscript' })) },
      cover: cover ? {
        fileName: cover.name,
        url: `/api/cover?projectId=${encodeURIComponent(id)}&v=${encodeURIComponent(String(cover.mtimeMs))}`
      } : null,
      loose: {
        dir,
        selectedVersion: selected.fileName,
        selectedVersionIndex: selectedIndex,
        versions: versions.map((version) => ({ fileName: version.fileName, modifiedAt: version.modifiedAt, size: version.size, score: version.score }))
      },
      logs: [],
      flags: [],
      canonDeltas: [],
      metrics: { words, target: 0, remaining: 0, percent: chapters.length ? 100 : 0, finalChapters: 0 },
      chapterHealth: [],
      runMonitor: null
    };
  }).filter(Boolean));
}

function getLooseProject(id) {
  return getLooseProjects().find((project) => project.id === id) || null;
}

function readLooseChapter(relativePath) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/');
  const projectId = parts[1];
  const versionIndex = Math.max(0, Number(parts[2] || 0));
  const chapterNumber = Math.max(1, Number((parts[3] || '').match(/\d+/) && (parts[3] || '').match(/\d+/)[0] || 1));
  const project = getLooseProject(projectId);
  if (!project || !project.loose || !looseAllowedDir(project.loose.dir)) throw new Error('Loose manuscript not found');
  const version = project.loose.versions[versionIndex] || project.loose.versions[project.loose.selectedVersionIndex] || project.loose.versions[0];
  const fullVersion = listLooseVersions(project.loose.dir).find((item) => item.fileName === version.fileName);
  if (!fullVersion) throw new Error('DOCX version not found');
  const chapters = parseLooseDocxChapters(fullVersion.path);
  const chapter = chapters.find((item) => item.num === chapterNumber) || chapters[0];
  return { path: relativePath, content: chapter ? chapter.text : '', words: chapter ? chapter.words : 0 };
}

function findBibleFile(projectId) {
  const dir = projectDir(projectId);
  if (!fs.existsSync(dir)) return null;
  const direct = fs.readdirSync(dir)
    .filter((name) => /bible.*\.docx$/i.test(name) || /\.bible\.docx$/i.test(name))
    .map((name) => path.join(dir, name));
  return direct[0] || null;
}

function sectionKey(title) {
  return normalizeText(title)
    .toLowerCase()
    .replace(/^section\s+\w+:\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getBible(projectId) {
  const file = findBibleFile(projectId);
  if (!file) return { found: false, sections: [], headings: [], paragraphs: [], rules: { words: [], constructions: [] } };
  const paragraphs = parseDocxParagraphs(file);
  const sections = [];
  let current = null;
  paragraphs.forEach((paragraph) => {
    if (/^Heading [123]$/.test(paragraph.style) || paragraph.style === 'Title' || paragraph.style === 'Subtitle') {
      current = {
        key: sectionKey(paragraph.text),
        title: paragraph.text,
        level: paragraph.style,
        text: ''
      };
      sections.push(current);
      return;
    }
    if (current) current.text += (current.text ? '\n' : '') + paragraph.text;
  });
  const headings = sections.map(({ key, title, level }) => ({ key, title, level }));
  return {
    found: true,
    file: path.basename(file),
    updatedAt: fs.statSync(file).mtime.toISOString(),
    headings,
    sections,
    paragraphs,
    rules: extractRules(sections)
  };
}

function placeholderId(text, index) {
  return `ph-${index}-${crc32(Buffer.from(normalizeText(text), 'utf8')).toString(16)}`;
}

function extractBiblePlaceholders(projectId) {
  const bible = getBible(projectId);
  if (!bible.paragraphs) return [];
  return bible.paragraphs
    .filter((paragraph) => /PLACEHOLDER|\bTBD\b|\bTODO\b/i.test(paragraph.text))
    .map((paragraph) => ({
      id: placeholderId(paragraph.text, paragraph.index),
      index: paragraph.index,
      text: normalizeText(paragraph.text).slice(0, 500)
    }));
}

function bibleCleanupPath(projectId) {
  return path.join(projectDir(projectId), 'bible-cleanup.json');
}

function getBibleCleanup(projectId) {
  const saved = readJson(bibleCleanupPath(projectId), {});
  const items = extractBiblePlaceholders(projectId).map((placeholder) => ({
    status: 'needs-decision',
    category: 'general',
    note: '',
    updatedAt: '',
    ...(saved[placeholder.id] || {}),
    ...placeholder
  }));
  return { items, counts: countBy(items, 'status') };
}

function updateBibleCleanup(projectId, id, patch = {}) {
  const allowedStatuses = ['needs-decision', 'ready-to-fill', 'handled', 'ignore-for-now'];
  const allowedCategories = ['character', 'setting', 'timeline', 'relationship', 'plot', 'voice', 'market', 'general'];
  const currentItems = getBibleCleanup(projectId).items;
  if (!currentItems.some((item) => item.id === id)) throw new Error('Placeholder not found');
  const saved = readJson(bibleCleanupPath(projectId), {});
  const current = saved[id] || {};
  const next = { ...current };
  if (patch.status !== undefined) next.status = allowedStatuses.includes(patch.status) ? patch.status : 'needs-decision';
  if (patch.category !== undefined) next.category = allowedCategories.includes(patch.category) ? patch.category : 'general';
  if (patch.note !== undefined) next.note = normalizeText(patch.note).trim();
  next.updatedAt = new Date().toISOString();
  saved[id] = next;
  writeJson(bibleCleanupPath(projectId), saved);
  addLog(projectId, 'bible', `Updated bible cleanup placeholder ${id}`);
  return getBibleCleanup(projectId);
}

function makeBibleCleanupPacket(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const bible = getBible(projectId);
  const cleanup = getBibleCleanup(projectId);
  const active = cleanup.items.filter((item) => !['handled', 'ignore-for-now'].includes(item.status));
  const groups = ['needs-decision', 'ready-to-fill'].map((status) => {
    const items = active.filter((item) => item.status === status);
    return [
      `## ${status === 'needs-decision' ? 'Needs Decision' : 'Ready To Fill'}`,
      items.length ? items.map((item) => [
        `- ID: ${item.id}`,
        `  Category: ${item.category}`,
        `  Placeholder: ${item.text}`,
        item.note ? `  Alex note: ${item.note}` : ''
      ].filter(Boolean).join('\n')).join('\n') : '- None'
    ].join('\n');
  });
  const content = [
    `# ${project.config.title} - Bible cleanup packet`,
    '',
    '## Task',
    'Help resolve project-bible placeholders. Do not invent canon. Use the manuscript, existing bible rules, and Alex notes as constraints. If a choice needs Alex, return FLAG: with the exact decision needed.',
    '',
    '## Bible',
    `File: ${bible.file || 'Not found'}`,
    `Open cleanup items: ${active.length}`,
    '',
    ...groups,
    '',
    '## Output Contract',
    '- Return proposed replacement text by placeholder ID.',
    '- Keep each replacement concise and suitable for a story bible.',
    '- Preserve established voice, ending constraints, and unreliability rules.',
    '- Do not rewrite unrelated bible sections.'
  ].join('\n');
  return { content: normalizeText(content), items: active.length, bibleFound: bible.found };
}

function replaceParagraphText(pXml, replacement) {
  const pPr = (pXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/) || [''])[0];
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(replacement)}</w:t></w:r></w:p>`;
}

function applyBibleCleanup(projectId) {
  const bibleFile = findBibleFile(projectId);
  if (!bibleFile) throw new Error('Bible DOCX not found');
  const cleanup = getBibleCleanup(projectId);
  const replacements = cleanup.items.filter((item) => item.status === 'handled' && item.note.trim());
  if (!replacements.length) throw new Error('No handled cleanup items with replacement notes');
  const byId = new Map(replacements.map((item) => [item.id, item]));
  const entries = readZipEntries(bibleFile);
  const document = entries.find((entry) => entry.name === 'word/document.xml');
  if (!document) throw new Error('DOCX document.xml not found');
  let replaced = 0;
  let paragraphIndex = 0;
  const xml = document.data.toString('utf8').replace(/<w:p[\s\S]*?<\/w:p>/g, (pXml) => {
    const text = normalizeText(paragraphTextFromXml(pXml)).trim();
    const id = placeholderId(text, paragraphIndex);
    paragraphIndex += 1;
    const item = byId.get(id);
    if (!item) return pXml;
    replaced += 1;
    return replaceParagraphText(pXml, item.note);
  });
  if (!replaced) throw new Error('No matching placeholders found in the current Bible DOCX');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `${path.basename(bibleFile, '.docx')}.backup-${stamp}.docx`;
  const backup = path.join(path.dirname(bibleFile), backupName);
  fs.copyFileSync(bibleFile, backup);
  document.data = Buffer.from(xml, 'utf8');
  const tempDir = fs.mkdtempSync(path.join(path.dirname(bibleFile), 'bible-build-'));
  try {
    entries.forEach((entry) => {
      const full = path.join(tempDir, entry.name);
      ensureDir(path.dirname(full));
      fs.writeFileSync(full, entry.data);
    });
    zipFiles(entries.map((entry) => ({ full: path.join(tempDir, entry.name), name: entry.name })), bibleFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  addLog(projectId, 'bible', `Applied ${replaced} bible cleanup replacements`);
  return { replaced, backup: REPO_MODE ? `${projectId}/${backupName}` : `projects/${projectId}/${backupName}` };
}

function editorReturnsPath(projectId) {
  return path.join(projectDir(projectId), 'editor-returns.json');
}

function getEditorReturns(projectId) {
  return readJson(editorReturnsPath(projectId), []);
}

function saveEditorReturn(projectId, input = {}) {
  const list = getEditorReturns(projectId);
  const item = {
    id: input.id || `return-${Date.now().toString(36)}`,
    label: normalizeText(input.label || 'Editor return').trim(),
    fileName: normalizeText(input.fileName || '').trim(),
    returnedAt: normalizeText(input.returnedAt || new Date().toISOString().slice(0, 10)).trim(),
    status: normalizeText(input.status || 'received').trim(),
    chapters: normalizeText(input.chapters || '').trim(),
    notes: normalizeText(input.notes || '').trim(),
    updatedAt: new Date().toISOString()
  };
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) list[index] = item;
  else list.unshift(item);
  writeJson(editorReturnsPath(projectId), list);
  addLog(projectId, 'roundtrip', `Logged editor return: ${item.label}`);
  return { returns: list };
}

function getReadiness(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const health = getBibleHealth(projectId);
  const cleanup = getBibleCleanup(projectId);
  const returns = getEditorReturns(projectId);
  const chapters = [...project.chapters, ...project.planned];
  const gateStatsList = gateStatsForProject(chapters);
  const openCleanup = cleanup.items.filter((item) => !['handled', 'ignore-for-now'].includes(item.status));
  const issues = [];
  if (project.flags.some((flag) => !flag.done)) issues.push(`${project.flags.filter((flag) => !flag.done).length} open flags`);
  if (health.openDeltas.length) issues.push(`${health.openDeltas.length} unresolved canon deltas`);
  if (openCleanup.length) issues.push(`${openCleanup.length} active bible cleanup items`);
  if (health.missingSummaries.length) issues.push(`${health.missingSummaries.length} missing chapter summaries`);
  if (health.missingMetadata.length) issues.push(`${health.missingMetadata.length} chapters missing metadata`);
  if (project.chapters.some((chapter) => chapter.status !== 'final')) issues.push(`${project.chapters.filter((chapter) => chapter.status !== 'final').length} drafted chapters not final`);
  const scoreBase = 6;
  const score = Math.max(0, Math.round(((scoreBase - issues.length) / scoreBase) * 100));
  return {
    score,
    issues,
    counts: {
      words: project.metrics.words,
      draftedChapters: project.chapters.length,
      finalChapters: project.metrics.finalChapters,
      openFlags: project.flags.filter((flag) => !flag.done).length,
      openDeltas: health.openDeltas.length,
      openCleanup: openCleanup.length,
      missingSummaries: health.missingSummaries.length,
      missingMetadata: health.missingMetadata.length,
      editorReturns: returns.length
    },
    gates: gateStatsList,
    recentReturns: returns.slice(0, 5)
  };
}

function gateStatsForProject(chapters) {
  const total = chapters.length || 1;
  return ['summary', 'metadata', 'canon', 'continuity', 'voice', 'character', 'intensity', 'line', 'bible'].map((key) => ({
    key,
    count: chapters.filter((chapter) => chapter.meta && chapter.meta.gates && chapter.meta.gates[key]).length,
    total
  }));
}

function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.title)) || null;
}

function sectionText(sections, pattern, fallback = '') {
  const section = findSection(sections, pattern);
  return section ? section.text.trim() : fallback;
}

function extractBullets(text) {
  return String(text || '').split(/\r?\n/)
    .map((line) => line.replace(/^[\s•*-]+/, '').trim())
    .filter(Boolean);
}

function extractRules(sections) {
  const bannedWords = extractBullets(sectionText(sections, /Banned Words/i));
  const bannedConstructions = extractBullets(sectionText(sections, /Banned Constructions/i));
  const extraWords = [
    'precise', 'precision', 'exact', 'exactly', 'methodical', 'meticulous',
    'specific', 'specifically', 'particular', 'cataloging', 'traced'
  ];
  const extraConstructions = [
    'staring into the middle distance', 'time passed', 'days blurred',
    'weeks went by', 'the days that followed', 'like someone who',
    'like a person who'
  ];
  return {
    words: Array.from(new Set([...bannedWords, ...extraWords])).slice(0, 200),
    constructions: Array.from(new Set([...bannedConstructions, ...extraConstructions])).slice(0, 200)
  };
}

function defaultChapterMeta(num) {
  return {
    num: Number(num),
    pov: '',
    location: '',
    timeline: '',
    purpose: '',
    emotionalTurn: '',
    heatLevel: 0,
    horrorLevel: 0,
    canonIntroduced: '',
    continuityRisks: '',
    revisionNotes: '',
    readiness: 'needs-review',
    passes: {
      draft: false,
      selfEdit: false,
      continuity: false,
      voiceRules: false,
      character: false,
      intensity: false,
      lineEdit: false,
      final: false
    },
    gates: {
      summary: false,
      metadata: false,
      canon: false,
      continuity: false,
      voice: false,
      character: false,
      intensity: false,
      line: false,
      bible: false
    },
    summary: '',
    startState: '',
    endState: '',
    nextMove: ''
  };
}

function chapterMetaPath(projectId) {
  return path.join(projectDir(projectId), 'chapters.json');
}

function getChapterMeta(projectId) {
  return readJson(chapterMetaPath(projectId), {});
}

function metaFor(metaMap, num) {
  const defaults = defaultChapterMeta(num);
  const saved = metaMap[String(num)] || {};
  return {
    ...defaults,
    ...saved,
    passes: { ...defaults.passes, ...(saved.passes || {}) },
    gates: { ...defaults.gates, ...(saved.gates || {}) }
  };
}

function saveChapterMeta(projectId, num, patch) {
  const meta = getChapterMeta(projectId);
  const key = String(Number(num));
  const current = metaFor(meta, key);
  const next = { ...current, ...patch, num: Number(num) };
  if (patch.passes && typeof patch.passes === 'object') {
    next.passes = { ...current.passes, ...patch.passes };
  }
  if (patch.gates && typeof patch.gates === 'object') {
    next.gates = { ...current.gates, ...patch.gates };
  }
  meta[key] = next;
  writeJson(chapterMetaPath(projectId), meta);
  addLog(projectId, 'metadata', `Updated chapter ${num} metadata`);
  return next;
}

function resolveProjectId(projectId) {
  if (projectId && getProject(projectId)) return projectId;
  const projects = getProjects();
  if (projectId && projects.some((project) => project.id === projectId)) return projectId;
  if (projects.length === 1) return projects[0].id;
  if (!projectId) throw new Error('Project ID is required');
  throw new Error(`Project not found: ${projectId}`);
}

function cleanChapterMetaPatch(input) {
  const allowed = [
    'pov', 'location', 'timeline', 'purpose', 'emotionalTurn', 'canonIntroduced',
    'continuityRisks', 'revisionNotes', 'readiness', 'summary', 'startState',
    'endState', 'nextMove'
  ];
  const patch = {};
  allowed.forEach((key) => {
    if (input[key] !== undefined) patch[key] = normalizeText(input[key]).trim();
  });
  if (input.heatLevel !== undefined) patch.heatLevel = Math.max(0, Math.min(5, Number(input.heatLevel) || 0));
  if (input.horrorLevel !== undefined) patch.horrorLevel = Math.max(0, Math.min(5, Number(input.horrorLevel) || 0));
  if (input.passes && typeof input.passes === 'object') patch.passes = input.passes;
  if (input.gates && typeof input.gates === 'object') patch.gates = input.gates;
  return patch;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function normalizeMetadataImportPayload(body, fallbackChapter) {
  const candidates = [
    body && body.content,
    body && body.metadata,
    body && body.meta,
    body && body.data,
    body && body.payload
  ].filter((value) => value !== undefined && value !== null && value !== '');
  let parsed = candidates.length ? parseMaybeJson(candidates[0]) : body;
  if (typeof parsed === 'string') parsed = parseMaybeJson(parsed);
  if (parsed && parsed.metadata && typeof parsed.metadata === 'object') parsed = { ...parsed.metadata, ...parsed, metadata: undefined };
  if (parsed && parsed.meta && typeof parsed.meta === 'object') parsed = { ...parsed.meta, ...parsed, meta: undefined };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Metadata payload must be a JSON object');
  const chapter = Number(parsed.chapter || parsed.chapterNumber || parsed.chapter_num || parsed.num || fallbackChapter);
  return { parsed, chapter };
}

function metadataImportReceiptPath(projectId) {
  return path.join(projectDir(projectId), 'sessions', 'metadata-import-receipts.json');
}

function addMetadataImportReceipt(projectId, receipt) {
  const file = metadataImportReceiptPath(projectId);
  const receipts = readJson(file, []);
  receipts.unshift(receipt);
  writeJson(file, receipts.slice(0, 50));
}

function importChapterMetadata(projectId, chapterNumber, raw) {
  const resolvedProjectId = resolveProjectId(projectId);
  const { parsed, chapter } = normalizeMetadataImportPayload(raw, chapterNumber);
  if (!chapter) throw new Error('Chapter number is required');
  const patch = cleanChapterMetaPatch(parsed);
  patch.gates = {
    ...(patch.gates || {}),
    summary: Boolean(patch.summary),
    metadata: Boolean(patch.pov || patch.location || patch.timeline || patch.purpose),
    canon: Boolean(patch.canonIntroduced)
  };
  const meta = saveChapterMeta(resolvedProjectId, chapter, patch);
  const deltas = [];
  (parsed.canonDeltas || []).filter(Boolean).forEach((delta) => {
    deltas.push(addCanonDelta(resolvedProjectId, typeof delta === 'string' ? { chapter, text: delta } : { chapter, ...delta }));
  });
  const flags = (parsed.flags || []).filter(Boolean);
  flags.forEach((flag) => addFlag(resolvedProjectId, flag));
  const receipt = {
    time: new Date().toISOString(),
    projectId: resolvedProjectId,
    chapter,
    fields: Object.keys(patch).filter((key) => key !== 'gates'),
    canonDeltas: deltas.length,
    flags: flags.length
  };
  addMetadataImportReceipt(resolvedProjectId, receipt);
  addLog(resolvedProjectId, 'metadata', `Imported metadata for chapter ${chapter}: ${receipt.fields.join(', ') || 'no fields'}`);
  return { ok: true, ...receipt, meta, deltas };
}

function toggleQualityGate(projectId, chapterNumber, gate, value) {
  const allowed = ['summary', 'metadata', 'canon', 'continuity', 'voice', 'character', 'intensity', 'line', 'bible'];
  if (!allowed.includes(gate)) throw new Error('Invalid quality gate');
  const current = metaFor(getChapterMeta(projectId), chapterNumber);
  const nextValue = value === undefined ? !current.gates[gate] : Boolean(value);
  return saveChapterMeta(projectId, chapterNumber, { gates: { [gate]: nextValue } });
}

function chapterNumberFromName(name, fallback = 0) {
  const base = path.basename(String(name || ''), path.extname(String(name || ''))).toLowerCase();
  const match = base.match(/(?:^|[^a-z])(?:chapter|chap|ch)?\.?\s*[-_ ]*(\d{1,3})(?:\b|[^a-z])/i)
    || base.match(/^(\d{1,3})(?:\b|[^a-z])/);
  return match ? Number(match[1]) : fallback;
}

function isLikelyManuscriptMarkdown(file) {
  const name = path.basename(file).toLowerCase();
  if (!/\.(md|txt)$/i.test(name)) return false;
  if (name === 'placeholder.md') return false;
  if (/editorial-state|session-log|progress|flags|readme|outline|bible|metadata|canon-deltas|scenes/i.test(name)) return false;
  return true;
}

function walkMarkdownFiles(dir, baseDir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(\.|node_modules|\.git|exports|snapshots)$/i.test(entry.name)) return [];
      return walkMarkdownFiles(full, baseDir, maxDepth, depth + 1);
    }
    if (!entry.isFile() || !isLikelyManuscriptMarkdown(entry.name)) return [];
    const stat = fs.statSync(full);
    return [{
      full,
      relative: path.relative(baseDir, full).replace(/\\/g, '/'),
      name: entry.name,
      updatedAt: stat.mtime.toISOString()
    }];
  });
}

function discoverManuscriptMarkdownFiles(projectId) {
  const root = projectDir(projectId);
  const preferredDirs = ['manuscript', 'chapters', 'chapter', 'draft', 'drafts', 'sections']
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(dir));
  const found = preferredDirs.flatMap((dir) => walkMarkdownFiles(dir, root));
  if (!found.length) {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isLikelyManuscriptMarkdown(entry.name))
      .map((entry) => {
        const full = path.join(root, entry.name);
        const stat = fs.statSync(full);
        return {
          full,
          relative: entry.name,
          name: entry.name,
          updatedAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
  }
  return found.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
}

function getChapters(id, config) {
  const metaMap = getChapterMeta(id);
  const files = discoverManuscriptMarkdownFiles(id);
  const chapters = files.map((file, index) => {
    const text = fs.readFileSync(file.full, 'utf8');
    const num = chapterNumberFromName(file.relative, index + 1) || index + 1;
    return {
      num,
      file: path.basename(file.relative),
      path: projectFilePathFromRelative(id, file.relative),
      title: firstHeading(text) || path.basename(file.name, path.extname(file.name)).replace(/[-_]+/g, ' '),
      beat: config.beats && config.beats[String(num)] || '',
      status: statusFrom(text, 'review'),
      words: wordCount(stripStatus(text)),
      meta: metaFor(metaMap, num),
      updatedAt: file.updatedAt
    };
  }).sort((a, b) => a.num - b.num || a.path.localeCompare(b.path, undefined, { numeric: true }));

  const written = new Set(chapters.map((chapter) => chapter.num));
  const planned = [];
  const total = Math.max(totalChapters(config), chapters.length);
  for (let i = 1; i <= total; i += 1) {
    if (!written.has(i)) {
      planned.push({
        num: i,
        file: `chapter-${String(i).padStart(2, '0')}.md`,
        path: null,
        title: `Chapter ${i}`,
        beat: config.beats && config.beats[String(i)] || '',
        status: 'planned',
        meta: metaFor(metaMap, i),
        words: 0
      });
    }
  }
  return { chapters, planned };
}

function firstHeading(text) {
  const line = String(text || '').split(/\r?\n/).find((value) => /^#\s+/.test(value));
  return line ? line.replace(/^#\s+/, '').trim() : '';
}

function getLogs(id) {
  const file = path.join(projectDir(id), 'sessions', 'progress.md');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => {
    const match = line.match(/^LOG\|([^|]+)\|([^|]+)\|(.+)$/);
    return match ? { time: match[1], type: match[2], text: match[3] } : null;
  }).filter(Boolean);
}

function getFlags(id) {
  const flagsFile = path.join(projectDir(id), 'sessions', 'flags.md');
  const progressFile = path.join(projectDir(id), 'sessions', 'progress.md');
  const deltas = getCanonDeltas(id);
  const flags = [];
  if (fs.existsSync(flagsFile)) {
    fs.readFileSync(flagsFile, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^- \[([ x])\] (.+)$/i);
      if (match) flags.push({ id: index + 1, done: match[1].toLowerCase() === 'x', source: 'flags', text: normalizeText(match[2]) });
    });
  }
  if (fs.existsSync(progressFile)) {
    fs.readFileSync(progressFile, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^FLAG:\s*(.+)$/i);
      if (match) {
        const text = normalizeText(match[1]);
        if (!isResolvedCanonProgressFlag(text, deltas)) {
          flags.push({ id: `progress-${index + 1}`, done: false, source: 'progress', text });
        }
      }
    });
  }
  return flags;
}

function canonDeltaIdFromFlagText(text) {
  const match = String(text || '').match(/delta id:\s*([^)—\s]+)/i);
  return match ? match[1].trim() : '';
}

function isResolvedCanonProgressFlag(text, deltas) {
  if (!/canon delta needs approval/i.test(text)) return false;
  const id = canonDeltaIdFromFlagText(text);
  if (!id) return false;
  const delta = (deltas || []).find((item) => item.id === id);
  return !delta || ['accepted', 'rejected'].includes(delta.status) || delta.applied === true;
}

function canonDeltaPath(projectId) {
  return path.join(projectDir(projectId), 'canon-deltas.json');
}

function getCanonDeltas(projectId) {
  return readJson(canonDeltaPath(projectId), []);
}

function saveCanonDeltas(projectId, deltas) {
  writeJson(canonDeltaPath(projectId), deltas);
}

function addCanonDelta(projectId, input) {
  const deltas = getCanonDeltas(projectId);
  const text = normalizeText(input.text || '').trim();
  if (!text) throw new Error('Canon delta text is required');
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    chapter: Number(input.chapter || 0) || null,
    category: input.category || 'general',
    targetSection: normalizeText(input.targetSection || '').trim(),
    text,
    applied: Boolean(input.applied),
    status: input.status || (input.applied ? 'accepted' : 'candidate'),
    resolution: ''
  };
  deltas.push(item);
  saveCanonDeltas(projectId, deltas);
  addLog(projectId, 'canon', `Added canon delta: ${text.slice(0, 80)}`);
  return item;
}

function updateCanonDelta(projectId, id, patch) {
  const deltas = getCanonDeltas(projectId);
  const index = deltas.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('Canon delta not found');
  deltas[index] = {
    ...deltas[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  if (patch.text !== undefined) deltas[index].text = normalizeText(patch.text).trim();
  if (patch.resolution !== undefined) deltas[index].resolution = normalizeText(patch.resolution).trim();
  saveCanonDeltas(projectId, deltas);
  addLog(projectId, 'canon', `Updated canon delta ${id}`);
  return deltas[index];
}

function canonTargetForDelta(projectId, delta) {
  const target = normalizeText(delta.targetSection || '').trim().replace(/\\/g, '/');
  if (target && /\.(md|txt)$/i.test(target)) return safeJoin(projectDir(projectId), target);
  const slug = slugify(target || delta.category || 'general');
  const category = String(delta.category || 'general').toLowerCase();
  if (category === 'character' || category === 'relationship') return path.join(projectDir(projectId), 'characters', `${slug || 'canon-updates'}.md`);
  if (category === 'unreliability') return path.join(projectDir(projectId), 'sessions', 'unreliability_map.md');
  if (category === 'setting' || category === 'timeline' || category === 'general') return path.join(projectDir(projectId), 'worldbuilding', `${slug || 'canon-updates'}.md`);
  if (category === 'plot' || category === 'ending') return path.join(projectDir(projectId), 'outlines', `${slug || 'canon-updates'}.md`);
  return path.join(projectDir(projectId), 'worldbuilding', 'canon-updates.md');
}

function appendCanonDeltaToTarget(projectId, delta) {
  const file = canonTargetForDelta(projectId, delta);
  ensureDir(path.dirname(file));
  const header = '## Canon updates';
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ')}\n\n`;
  if (!new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(content)) {
    content = content.replace(/\s*$/, `\n\n${header}\n`);
  }
  const entry = [
    '',
    `- ${normalizeText(delta.text).trim()}`,
    `  - Source: Chapter ${delta.chapter || '?'}, ${delta.category || 'general'} delta ${delta.id}`,
    delta.targetSection ? `  - Target: ${normalizeText(delta.targetSection).trim()}` : ''
  ].filter(Boolean).join('\n');
  if (!content.includes(`delta ${delta.id}`)) content = content.replace(/\s*$/, `${entry}\n`);
  fs.writeFileSync(file, content, 'utf8');
  return path.relative(projectDir(projectId), file).replace(/\\/g, '/');
}

function writeResumeSignal(projectId, action, id) {
  const file = path.join(projectDir(projectId), 'sessions', 'resume.signal');
  ensureDir(path.dirname(file));
  const status = action === 'approved' || action === 'approve' ? 'approved' : 'rejected';
  fs.writeFileSync(file, `${id}|${status}`, 'utf8');
}

function reviewCanonDelta(projectId, id, action) {
  const delta = getCanonDeltas(projectId).find((item) => item.id === id);
  if (!delta) throw new Error('Canon delta not found');
  if (action === 'approve') {
    const targetFile = appendCanonDeltaToTarget(projectId, delta);
    const updated = updateCanonDelta(projectId, id, { status: 'accepted', applied: true, resolution: `Approved into ${targetFile}` });
    writeResumeSignal(projectId, 'approved', id);
    addLog(projectId, 'canon', `Approved canon delta ${id} into ${targetFile}`);
    return { delta: updated, targetFile, signal: `${id}|approved` };
  }
  if (action === 'reject') {
    const updated = updateCanonDelta(projectId, id, { status: 'rejected', applied: false, resolution: 'Rejected by Alex' });
    writeResumeSignal(projectId, 'rejected', id);
    addLog(projectId, 'canon', `Rejected canon delta ${id}`);
    return { delta: updated, signal: `${id}|rejected` };
  }
  throw new Error('Invalid canon review action');
}

function newestProjectContentTime(projectId) {
  const buckets = ['manuscript', 'outlines', 'characters', 'worldbuilding', 'sessions'];
  let newest = 0;
  buckets.forEach((bucket) => {
    const dir = path.join(projectDir(projectId), bucket);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach((name) => {
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) newest = Math.max(newest, fs.statSync(file).mtimeMs);
    });
  });
  return newest;
}

function getBibleHealth(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const bible = getBible(projectId);
  const deltas = getCanonDeltas(projectId);
  const openDeltas = deltas.filter((item) => !['accepted', 'rejected'].includes(item.status));
  const placeholders = extractBiblePlaceholders(projectId).map((placeholder) => ({ ...placeholder, text: placeholder.text.slice(0, 240) }));
  const missingSummaries = [...project.chapters, ...project.planned].filter((chapter) => !chapter.meta || !chapter.meta.summary).map((chapter) => chapter.num);
  const missingMetadata = [...project.chapters, ...project.planned].filter((chapter) => {
    const meta = chapter.meta || {};
    return !meta.pov && !meta.location && !meta.timeline && !meta.purpose;
  }).map((chapter) => chapter.num);
  const bibleFile = findBibleFile(projectId);
  const bibleTime = bibleFile ? fs.statSync(bibleFile).mtimeMs : 0;
  const newestContentTime = newestProjectContentTime(projectId);
  const staleBible = Boolean(bibleTime && newestContentTime > bibleTime);
  return {
    bibleFound: bible.found,
    bibleFile: bible.file || '',
    bibleUpdatedAt: bible.updatedAt || '',
    staleBible,
    placeholders,
    openDeltas,
    openFlags: project.flags.filter((flag) => !flag.done),
    missingSummaries,
    missingMetadata,
    counts: {
      placeholders: placeholders.length,
      openDeltas: openDeltas.length,
      openFlags: project.flags.filter((flag) => !flag.done).length,
      missingSummaries: missingSummaries.length,
      missingMetadata: missingMetadata.length
    }
  };
}

function splitArgs(text) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) args.push(match[1] ?? match[2] ?? match[0]);
  return args;
}

function claudeConfig() {
  return {
    command: envValue('CLAUDE_COMMAND') || 'claude',
    argsTemplate: envValue('CLAUDE_ARGS_TEMPLATE') || '-p {prompt}'
  };
}

function claudePromptFor(project, input) {
  const action = input.action || 'draft-next';
  const chapter = input.chapter ? Number(input.chapter) : 0;
  const chapterText = chapter ? ` chapter ${chapter}` : '';
  const title = project.config && project.config.title ? project.config.title : project.id;
  const mcpHint = [
    'Use the Holdfast MCP tools for status, context, metadata sync, canon deltas, and approvals.',
    'Do not ask me to paste context from the OS. Pull what you need through Holdfast.',
    'When chapter work is complete, submit metadata and canon deltas back to Holdfast.'
  ].join(' ');
  const actions = {
    'draft-next': `Continue drafting the next planned chapter for "${title}".`,
    'draft-chapter': `Draft${chapterText} for "${title}".`,
    'keep-drafting': `Keep drafting "${title}" from the current pipeline state until you hit an approval gate or useful stopping point.`,
    'self-edit': `Self-edit${chapterText} for "${title}" using the configured author rules and update Holdfast when done.`,
    'revise': `Revise${chapterText} for "${title}" according to current Holdfast metadata, flags, and canon state.`,
    'audit': `Run the appropriate quality/canon/dialogue audit${chapterText} for "${title}" and report results back to Holdfast.`,
    'metadata-sync': `Inspect${chapterText || ' the latest drafted chapter'} for "${title}" and submit/repair Holdfast chapter metadata.`
  };
  const extra = normalizeText(input.extra || '').trim();
  return normalizeText(`${actions[action] || actions['draft-next']}\n\n${mcpHint}\n\nProject id: ${project.id}${chapter ? `\nChapter: ${chapter}` : ''}${extra ? `\n\nExtra direction:\n${extra}` : ''}`).trim();
}

function startClaudeJob(input) {
  const projectId = resolveProjectId(input.projectId);
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const config = claudeConfig();
  const prompt = normalizeText(input.prompt || claudePromptFor(project, input)).trim();
  if (!prompt) throw new Error('Claude job prompt is empty');
  const promptFile = path.join(projectDir(projectId), 'sessions', `claude-job-${Date.now()}.txt`);
  ensureDir(path.dirname(promptFile));
  fs.writeFileSync(promptFile, prompt + '\n', 'utf8');
  const args = splitArgs(config.argsTemplate).map((arg) => arg
    .replace(/\{prompt\}/g, prompt)
    .replace(/\{promptFile\}/g, promptFile)
    .replace(/\{projectId\}/g, projectId)
    .replace(/\{chapter\}/g, String(input.chapter || ''))
  );
  const id = `claude-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job = {
    id,
    projectId,
    action: input.action || 'draft-next',
    chapter: input.chapter || '',
    command: config.command,
    args,
    promptFile,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    output: '',
    error: ''
  };
  claudeJobs.set(id, job);
  addLog(projectId, 'claude', `Started ${job.action}${job.chapter ? ` for chapter ${job.chapter}` : ''}`);
  let child;
  try {
    child = childProcess.spawn(config.command, args, {
      cwd: projectDir(projectId),
      shell: process.platform === 'win32',
      windowsHide: true,
      env: {
        ...process.env,
        HOLDFAST_URL: `http://127.0.0.1:${envValue('PORT') || PORT}`,
        HOLDFAST_PROJECT_ID: projectId
      }
    });
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    addLog(projectId, 'claude', `Failed to start Claude job: ${error.message}`);
    return job;
  }
  job.pid = child.pid;
  child.stdout.on('data', (chunk) => {
    job.output = (job.output + chunk.toString()).slice(-20000);
  });
  child.stderr.on('data', (chunk) => {
    job.error = (job.error + chunk.toString()).slice(-12000);
  });
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = (job.error + '\n' + error.message).trim();
    addLog(projectId, 'claude', `Claude job failed: ${error.message}`);
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.status = code === 0 ? 'complete' : 'failed';
    job.finishedAt = new Date().toISOString();
    addLog(projectId, 'claude', `Claude job ${job.status}: ${job.action}${job.chapter ? ` chapter ${job.chapter}` : ''}`);
  });
  job.child = child;
  return publicClaudeJob(job);
}

function publicClaudeJob(job) {
  const { child, ...safe } = job;
  return safe;
}

function getClaudeJobs(projectId) {
  const resolved = projectId ? resolveProjectId(projectId) : '';
  return Array.from(claudeJobs.values())
    .filter((job) => !resolved || job.projectId === resolved)
    .slice(-20)
    .reverse()
    .map(publicClaudeJob);
}

function cancelClaudeJob(id) {
  const job = claudeJobs.get(id);
  if (!job) throw new Error('Claude job not found');
  if (job.child && job.status === 'running') {
    job.child.kill();
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    addLog(job.projectId, 'claude', `Cancelled Claude job ${id}`);
  }
  return publicClaudeJob(job);
}

function getProject(id, rootHint = '') {
  const dir = rootHint ? safeJoin(rootHint, id) : projectDir(id);
  const projectRoot = path.dirname(dir);
  const configFile = path.join(dir, 'project.json');
  const config = readJson(configFile, null);
  if (!config) return null;
  if (!config.chapters) config.chapters = totalChapters(config);
  const inferredPenName = penNameForProjectRoot(projectRoot);
  if (inferredPenName && config.penName !== inferredPenName) {
    config.penName = inferredPenName;
    writeJson(configFile, config);
  } else if (!config.penName || isRetiredPenName(config.penName)) {
    config.penName = getSettings().author || DEFAULT_PEN_NAME;
    writeJson(configFile, config);
  }
  const { chapters, planned } = getChapters(id, config);
  const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
  const target = Number(config.targetWords || 90000);
  const files = {
    manuscript: listMarkdownFiles(path.join(dir, 'manuscript'), id, 'manuscript'),
    outlines: listMarkdownFiles(path.join(dir, 'outlines'), id, 'outlines'),
    characters: listMarkdownFiles(path.join(dir, 'characters'), id, 'characters'),
    worldbuilding: listMarkdownFiles(path.join(dir, 'worldbuilding'), id, 'worldbuilding'),
    sessions: listMarkdownFiles(path.join(dir, 'sessions'), id, 'sessions')
  };
  const cover = findCoverFile(dir);
  const project = {
    id,
    config,
    chapters,
    planned,
    files,
    cover: cover ? {
      fileName: cover.name,
      url: `/api/cover?projectId=${encodeURIComponent(id)}&v=${encodeURIComponent(String(cover.mtimeMs))}`
    } : null,
    logs: getLogs(id),
    flags: getFlags(id),
    canonDeltas: getCanonDeltas(id),
    metrics: {
      words,
      target,
      remaining: Math.max(0, target - words),
      percent: target ? Math.min(100, Math.round((words / target) * 100)) : 0,
      finalChapters: chapters.filter((chapter) => chapter.status === 'final').length
    }
  };
  project.chapterHealth = chapterHealth(id, project);
  project.runMonitor = getRunMonitor(id, project);
  return project;
}

function findCoverFile(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && COVER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const lower = entry.name.toLowerCase();
      let score = 0;
      if (lower.includes('cover')) score += 20;
      if (lower.includes('ku')) score += 8;
      if (lower.includes('kindle')) score += 6;
      if (lower.includes('ebook')) score += 5;
      if (lower.includes('front')) score += 4;
      if (lower.endsWith('.png')) score += 2;
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, path: fullPath, score, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return entries[0] || null;
}

function coverMimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function getProjects() {
  const cleanProjects = projectRoots().flatMap((dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'project.json')))
      .map((entry) => getProject(entry.name, dir));
  })
    .filter(Boolean)
    .filter((project, index, projects) => projects.findIndex((other) => other.id === project.id) === index)
    .sort((a, b) => a.config.title.localeCompare(b.config.title));
  const looseProjects = getLooseProjects();
  return [...cleanProjects, ...looseProjects]
    .filter((project, index, projects) => projects.findIndex((other) => other.id === project.id) === index)
    .sort((a, b) => a.config.title.localeCompare(b.config.title));
}

function createChapter(projectId, number, title = '') {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const num = Math.max(1, Math.min(999, Number(number || 1)));
  const filename = `chapter-${String(num).padStart(2, '0')}.md`;
  const file = path.join(projectDir(projectId), 'manuscript', filename);
  if (fs.existsSync(file)) return { path: projectFilePath(projectId, 'manuscript', filename) };
  const chapterTitle = title || `Chapter ${num}`;
  const beat = project.config.beats && project.config.beats[String(num)] || '';
  fs.writeFileSync(file, `STATUS: drafting\n\n# ${chapterTitle}\n\n${beat ? `> ${beat}\n\n` : ''}`, 'utf8');
  addLog(projectId, 'chapter', `Chapter ${num} created`);
  return { path: projectFilePath(projectId, 'manuscript', filename) };
}

function updateStage(projectId, fileName, stage) {
  if (!STAGES.includes(stage)) throw new Error('Invalid stage');
  const file = path.join(projectDir(projectId), 'manuscript', fileName);
  if (!fs.existsSync(file)) throw new Error('Chapter not found');
  let text = fs.readFileSync(file, 'utf8');
  if (/^STATUS:\s*.*$/im.test(text)) {
    text = text.replace(/^STATUS:\s*.*$/im, `STATUS: ${stage}`);
  } else {
    text = `STATUS: ${stage}\n\n${text}`;
  }
  fs.writeFileSync(file, text, 'utf8');
  addLog(projectId, 'stage', `${fileName} moved to ${stage}`);
}

function saveRelativeFile(relativePath, content) {
  const full = resolveRelativeFile(relativePath);
  const allowed = projectRoots().some((root) => {
    const safeRoot = path.resolve(root);
    const resolved = path.resolve(full);
    return resolved === safeRoot || resolved.startsWith(safeRoot + path.sep);
  });
  if (!allowed) throw new Error('Only project files can be edited');
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, String(content || ''), 'utf8');
}

function exportProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const dir = path.join(projectDir(projectId), 'exports');
  ensureDir(dir);
  const baseName = `${slugify(project.config.title)}-${new Date().toISOString().slice(0, 10)}`;
  const pieces = [];
  project.chapters.forEach((chapter) => {
    const text = fs.readFileSync(path.join(projectDir(projectId), 'manuscript', chapter.file), 'utf8');
    pieces.push(stripStatus(text).trim(), '\n');
  });
  const content = pieces.join('\n\n');
  const markdownName = `${baseName}.md`;
  const docxName = `${baseName}.docx`;
  fs.writeFileSync(path.join(dir, markdownName), content, 'utf8');
  writeDocxFromMarkdown(content, path.join(dir, docxName));
  const files = [
    { path: projectFilePath(projectId, 'exports', markdownName), fileName: markdownName, format: 'markdown' },
    { path: projectFilePath(projectId, 'exports', docxName), fileName: docxName, format: 'docx' }
  ];
  addLog(projectId, 'export', `Manuscript exported to ${markdownName}, ${docxName}`);
  return { path: files[1].path, fileName: files[1].fileName, files };
}

function selectedChapters(project, options = {}) {
  let chapters = project.chapters.slice();
  if (options.onlyFinal) chapters = chapters.filter((chapter) => chapter.status === 'final');
  const start = Number(options.startChapter || 0);
  const end = Number(options.endChapter || 0);
  if (start) chapters = chapters.filter((chapter) => chapter.num >= start);
  if (end) chapters = chapters.filter((chapter) => chapter.num <= end);
  if (options.act && Array.isArray(project.config.acts)) {
    const act = project.config.acts.find((item) => item.name === options.act);
    if (act) chapters = chapters.filter((chapter) => chapter.num >= Number(act.start) && chapter.num <= Number(act.end));
  }
  return chapters.sort((a, b) => a.num - b.num);
}

function metadataBlock(chapter) {
  const meta = chapter.meta || {};
  const gates = meta.gates || {};
  return [
    `- Status: ${chapter.status}`,
    `- Words: ${chapter.words}`,
    `- Beat: ${chapter.beat || ''}`,
    `- POV: ${meta.pov || ''}`,
    `- Location: ${meta.location || ''}`,
    `- Timeline: ${meta.timeline || ''}`,
    `- Purpose: ${meta.purpose || ''}`,
    `- Emotional turn: ${meta.emotionalTurn || ''}`,
    `- Heat/Horror: ${meta.heatLevel || 0}/${meta.horrorLevel || 0}`,
    `- Readiness: ${meta.readiness || 'needs-review'}`,
    `- Gates: ${Object.entries(gates).filter(([, value]) => value).map(([key]) => key).join(', ') || 'none'}`,
    `- Summary: ${meta.summary || ''}`,
    `- Canon introduced: ${meta.canonIntroduced || ''}`,
    `- Continuity risks: ${meta.continuityRisks || ''}`,
    `- Revision notes: ${meta.revisionNotes || ''}`,
    `- Next move: ${meta.nextMove || ''}`
  ].join('\n');
}

function assembleManuscript(projectId, project, options) {
  const pieces = [];
  selectedChapters(project, options).forEach((chapter) => {
    const text = readChapterText(projectId, chapter);
    if (options.includeChapterHeadings !== false && !/^#\s+/m.test(text)) pieces.push(`# Chapter ${chapter.num}`, '');
    pieces.push(text, '');
  });
  return pieces.join('\n').trim() + '\n';
}

function assembleReview(projectId, project, options) {
  const ruleReport = scanRules(projectId);
  const flags = project.flags.filter((flag) => !flag.done);
  const deltas = getCanonDeltas(projectId).filter((item) => !['accepted', 'rejected'].includes(item.status));
  const pieces = [`# ${project.config.title} - Review Export`, ''];
  selectedChapters(project, options).forEach((chapter) => {
    const hits = (ruleReport.results.find((item) => item.path === chapter.path) || { findings: [] }).findings;
    pieces.push(`## Chapter ${chapter.num}`, '', '### Metadata', metadataBlock(chapter), '', '### Rule Hits');
    pieces.push(hits.length ? hits.map((hit) => `- ${hit.rule} x ${hit.count}`).join('\n') : '- None');
    pieces.push('', '### Chapter Text', readChapterText(projectId, chapter), '');
  });
  pieces.push('## Open Flags', flags.length ? flags.map((flag) => `- ${flag.text}`).join('\n') : '- None', '');
  pieces.push('## Open Canon Deltas', deltas.length ? deltas.map((item) => `- [${item.status}] Ch. ${item.chapter || '?'} ${item.category}: ${item.text}`).join('\n') : '- None', '');
  return pieces.join('\n').trim() + '\n';
}

function assembleContext(projectId, project, options) {
  const bible = getBible(projectId);
  const sections = bible.sections || [];
  const pieces = [
    `# ${project.config.title} - Context Export`,
    '',
    '## North Star',
    sectionText(sections, /North Star Sentence/i, project.config.premise || ''),
    '',
    '## Voice / Unreliability',
    sectionText(sections, /POV and Tense/i),
    sectionText(sections, /Unreliability Rule/i),
    '',
    '## Chapter Summaries'
  ];
  selectedChapters(project, options).forEach((chapter) => {
    pieces.push(`### Chapter ${chapter.num}`, metadataBlock(chapter), '');
    if (options.includeText) pieces.push('#### Text', excerpt(readChapterText(projectId, chapter), Number(options.textLimit || 3000)), '');
  });
  pieces.push('## Open Flags', project.flags.filter((flag) => !flag.done).map((flag) => `- ${flag.text}`).join('\n') || '- None');
  pieces.push('', '## Open Canon Deltas', getCanonDeltas(projectId).filter((item) => !['accepted', 'rejected'].includes(item.status)).map((item) => `- [${item.status}] Ch. ${item.chapter || '?'} ${item.category}: ${item.text}`).join('\n') || '- None');
  return pieces.join('\n').trim() + '\n';
}

function assembleBibleUpdate(projectId, project) {
  return makeBibleUpdatePacket(projectId, project, getBible(projectId)).content + '\n';
}

function chapterContext(projectId, project, chapterNumber, options = {}) {
  const num = Number(chapterNumber || 0);
  const chapter = chapterByNumber(project, num);
  if (!chapter) throw new Error('Chapter not found');
  const previous = project.chapters.find((item) => item.num === chapter.num - 1);
  const next = project.chapters.find((item) => item.num === chapter.num + 1) || project.planned.find((item) => item.num === chapter.num + 1);
  const flags = project.flags.filter((flag) => !flag.done);
  const deltas = getCanonDeltas(projectId).filter((delta) => !['accepted', 'rejected'].includes(delta.status));
  const pieces = [
    `# ${project.config.title} - Chapter ${chapter.num} Context`,
    '',
    '## Project',
    `- Status: ${project.config.status || 'active'}`,
    `- Premise: ${project.config.premise || ''}`,
    `- Soft word guide: ${project.config.targetWords || ''}`,
    '',
    '## Chapter',
    metadataBlock(chapter),
    '',
    '## Neighboring Chapters',
    previous ? `- Previous Ch. ${previous.num}: ${(previous.meta && previous.meta.summary) || previous.beat || previous.title}` : '- Previous: none',
    next ? `- Next Ch. ${next.num}: ${(next.meta && next.meta.summary) || next.beat || next.title}` : '- Next: none',
    '',
    '## Open Flags',
    flags.length ? flags.map((flag) => `- ${flag.text}`).join('\n') : '- None',
    '',
    '## Open Canon Deltas',
    deltas.length ? deltas.map((delta) => `- [${delta.status}] Ch. ${delta.chapter || '?'} ${delta.category}: ${delta.text}`).join('\n') : '- None'
  ];
  if (options.includeText && chapter.path) {
    pieces.push('', '## Chapter Text', excerpt(readChapterText(projectId, chapter), Number(options.textLimit || 5000)));
  }
  return pieces.join('\n').trim() + '\n';
}

function openLoopsContext(projectId, project) {
  const health = getBibleHealth(projectId);
  const readiness = getReadiness(projectId);
  return [
    `# ${project.config.title} - Open Loops`,
    '',
    '## Readiness Issues',
    readiness.issues.length ? readiness.issues.map((issue) => `- ${issue}`).join('\n') : '- None',
    '',
    '## Open Flags',
    health.openFlags.length ? health.openFlags.map((flag) => `- ${flag.text}`).join('\n') : '- None',
    '',
    '## Pending Canon Deltas',
    health.openDeltas.length ? health.openDeltas.map((delta) => `- Ch. ${delta.chapter || '?'} ${delta.category}: ${delta.text}`).join('\n') : '- None',
    '',
    '## Bible Placeholders',
    health.placeholders.length ? health.placeholders.map((item) => `- ${item.text}`).join('\n') : '- None',
    '',
    '## Missing Metadata',
    health.missingMetadata.length ? `Chapters ${health.missingMetadata.join(', ')}` : 'None',
    '',
    '## Missing Summaries',
    health.missingSummaries.length ? `Chapters ${health.missingSummaries.join(', ')}` : 'None'
  ].join('\n').trim() + '\n';
}

function bibleContext(projectId, project) {
  const bible = getBible(projectId);
  const health = getBibleHealth(projectId);
  return [
    `# ${project.config.title} - Bible Context`,
    '',
    `Bible file: ${health.bibleFile || 'not found'}`,
    `Content newer than bible: ${health.staleBible ? 'yes' : 'no'}`,
    '',
    '## Bible Sections',
    (bible.sections || []).map((section) => `### ${section.title}\n${excerpt(section.text || '', 1800)}`).join('\n\n') || 'No bible sections found.',
    '',
    '## Pending Canon Deltas',
    health.openDeltas.length ? health.openDeltas.map((delta) => `- Ch. ${delta.chapter || '?'} ${delta.category}: ${delta.text}`).join('\n') : '- None'
  ].join('\n').trim() + '\n';
}

function buildAiContext(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const mode = options.mode || 'chapter';
  if (mode === 'chapter') return { mode, content: chapterContext(projectId, project, options.chapter, options) };
  if (mode === 'open-loops') return { mode, content: openLoopsContext(projectId, project) };
  if (mode === 'bible') return { mode, content: bibleContext(projectId, project) };
  if (mode === 'canon') return { mode, content: assembleBibleUpdate(projectId, project) };
  return { mode: 'project', content: assembleContext(projectId, project, { includeText: Boolean(options.includeText), textLimit: options.textLimit || 2500 }) };
}

function aiPrompt(context, prompt) {
  return [
    'You are assisting the configured author inside Book Machine OS.',
    'Use only the provided project context unless the user explicitly asks for general craft advice.',
    'Do not draft new manuscript prose unless the user explicitly asks. Prefer analysis, checklists, risks, summaries, metadata, and next actions.',
    '',
    '## User Request',
    normalizeText(prompt || '').trim(),
    '',
    '## Project Context',
    context
  ].join('\n');
}

function httpsJson(hostname, pathName, headers, payload) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || data.message || raw || `AI request failed with ${res.statusCode}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGetJson(hostname, pathName, headers = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: pathName,
      method: 'GET',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(data.error && data.error.message || data.message || raw || `Request failed with ${res.statusCode}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function pricePerMillion(value) {
  const n = Number(value || 0);
  if (n < 0) return null;
  return n * 1000000;
}

function normalizeOpenRouterModel(model) {
  const prompt = pricePerMillion(model.pricing && model.pricing.prompt);
  const completion = pricePerMillion(model.pricing && model.pricing.completion);
  return {
    id: model.id,
    name: model.name || model.id,
    contextLength: model.context_length || model.top_provider && model.top_provider.context_length || 0,
    promptPerMillion: prompt,
    completionPerMillion: completion,
    free: prompt === 0 && completion === 0,
    supportedParameters: model.supported_parameters || [],
    description: normalizeText(model.description || '').slice(0, 240)
  };
}

async function getOpenRouterModels(options = {}) {
  const maxAge = 6 * 60 * 60 * 1000;
  const now = Date.now();
  if (!openRouterModelCache || now - openRouterModelCacheAt > maxAge || options.refresh) {
    const data = await httpsGetJson('openrouter.ai', '/api/v1/models?output_modalities=text&sort=most-popular', {
      'HTTP-Referer': 'http://localhost',
      'X-OpenRouter-Title': 'Holdfast Book Machine'
    });
    openRouterModelCache = (data.data || []).map(normalizeOpenRouterModel).filter((model) => model.id);
    openRouterModelCacheAt = now;
  }
  let models = openRouterModelCache.slice();
  const q = normalizeText(options.q || '').toLowerCase();
  if (q) models = models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(q));
  if (options.free) models = models.filter((model) => model.free);
  if (options.family) {
    const family = String(options.family).toLowerCase();
    models = models.filter((model) => model.id.toLowerCase().includes(family));
  }
  const sort = options.sort || 'popular';
  if (sort === 'cheap') {
    models.sort((a, b) => ((a.promptPerMillion ?? 999999) + (a.completionPerMillion ?? 999999)) - ((b.promptPerMillion ?? 999999) + (b.completionPerMillion ?? 999999)));
  } else if (sort === 'context') {
    models.sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  } else if (sort === 'name') {
    models.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { cachedAt: openRouterModelCacheAt ? new Date(openRouterModelCacheAt).toISOString() : '', models: models.slice(0, Number(options.limit || 250)) };
}

async function runAiTask(input) {
  const projectId = input.projectId;
  const provider = input.provider || 'anthropic';
  const context = buildAiContext(projectId, input).content;
  const prompt = aiPrompt(context, input.prompt || '');
  if (provider === 'openai') {
    const openAiKey = envValue('OPENAI_API_KEY');
    if (!openAiKey) throw new Error('OPENAI_API_KEY is not configured');
    const model = input.model || 'gpt-4.1-mini';
    const data = await httpsJson('api.openai.com', '/v1/chat/completions', {
      Authorization: `Bearer ${openAiKey}`
    }, {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: Number(input.temperature || 0.2)
    });
    return { provider, model, context, content: data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '' };
  }
  if (provider === 'openrouter') {
    const openRouterKey = envValue('OPENROUTER_API_KEY');
    if (!openRouterKey) throw new Error('OPENROUTER_API_KEY is not configured');
    const model = input.model || 'anthropic/claude-3.5-sonnet';
    const data = await httpsJson('openrouter.ai', '/api/v1/chat/completions', {
      Authorization: `Bearer ${openRouterKey}`,
      'HTTP-Referer': 'http://localhost',
      'X-OpenRouter-Title': 'Holdfast Book Machine'
    }, {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: Number(input.temperature || 0.2)
    });
    return { provider, model, context, content: data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '' };
  }
  const anthropicKey = envValue('ANTHROPIC_API_KEY');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const model = input.model || 'claude-3-5-sonnet-latest';
  const data = await httpsJson('api.anthropic.com', '/v1/messages', {
    'x-api-key': anthropicKey,
    'anthropic-version': '2023-06-01'
  }, {
    model,
    max_tokens: Number(input.maxTokens || 2500),
    temperature: Number(input.temperature || 0.2),
    messages: [{ role: 'user', content: prompt }]
  });
  const content = (data.content || []).map((part) => part.text || '').join('\n').trim();
  return { provider, model, context, content };
}

function saveAiResponse(projectId, title, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `ai-response-${stamp}.md`;
  const file = path.join(projectDir(projectId), 'sessions', fileName);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `# ${normalizeText(title || 'AI Response')}\n\n${normalizeText(content || '')}\n`, 'utf8');
  addLog(projectId, 'ai', `Saved ${fileName}`);
  return { path: projectFilePath(projectId, 'sessions', fileName), fileName };
}

function docxRun(text, options = {}) {
  const props = [];
  if (options.bold) props.push('<w:b/>');
  if (options.italic) props.push('<w:i/>');
  const runProps = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function docxRunsFromMarkdown(text) {
  return String(text || '').split(/\n/).map((part, lineIndex) => {
    const runs = [];
    if (lineIndex) runs.push('<w:r><w:br/></w:r>');
    const re = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*)/g;
    let last = 0;
    let match;
    while ((match = re.exec(part))) {
      if (match.index > last) runs.push(docxRun(part.slice(last, match.index)));
      if (match[2] !== undefined) runs.push(docxRun(match[2], { bold: true }));
      else runs.push(docxRun(match[3], { italic: true }));
      last = match.index + match[0].length;
    }
    if (last < part.length) runs.push(docxRun(part.slice(last)));
    return runs.join('');
  }).join('');
}

function docxParagraph(text, style = '') {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  const runs = docxRunsFromMarkdown(text);
  return `<w:p>${styleXml}${runs}</w:p>`;
}

function docxPageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function markdownToDocxBody(markdown) {
  const lines = normalizeText(markdown).replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let paragraph = [];
  let previousWasChapterHeading = false;
  function flush() {
    if (!paragraph.length) return;
    parts.push(docxParagraph(paragraph.join(' ')));
    paragraph = [];
    previousWasChapterHeading = false;
  }
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      return;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      const text = heading[2].trim();
      const isChapter = /^chapter\s+\d+/i.test(text);
      if (isChapter && parts.length && !previousWasChapterHeading) parts.push(docxPageBreak());
      parts.push(docxParagraph(text, heading[1].length === 1 ? 'Heading1' : 'Heading2'));
      previousWasChapterHeading = isChapter;
      return;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flush();
      parts.push(docxParagraph(`- ${bullet[1].trim()}`));
      previousWasChapterHeading = false;
      return;
    }
    paragraph.push(trimmed);
  });
  flush();
  return parts.join('');
}

function writeDocxFromMarkdown(markdown, destination) {
  const body = markdownToDocxBody(markdown);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:line="480" w:lineRule="auto" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const tempDir = fs.mkdtempSync(path.join(path.dirname(destination), 'docx-build-'));
  try {
    const files = [
      ['[Content_Types].xml', contentTypes],
      ['_rels/.rels', rels],
      ['word/document.xml', documentXml],
      ['word/_rels/document.xml.rels', docRels],
      ['word/styles.xml', stylesXml]
    ];
    files.forEach(([name, content]) => {
      const full = path.join(tempDir, name);
      ensureDir(path.dirname(full));
      fs.writeFileSync(full, content, 'utf8');
    });
    zipFiles(files.map(([name]) => ({ full: path.join(tempDir, name), name })), destination);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assembleExport(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const mode = options.mode || 'manuscript';
  const format = options.format || 'markdown';
  let content = '';
  if (mode === 'review') content = assembleReview(projectId, project, options);
  else if (mode === 'context') content = assembleContext(projectId, project, options);
  else if (mode === 'bible-update') content = assembleBibleUpdate(projectId, project);
  else content = assembleManuscript(projectId, project, options);
  const dir = path.join(projectDir(projectId), 'exports');
  ensureDir(dir);
  const baseName = `${slugify(project.config.title)}-${slugify(mode)}-${new Date().toISOString().slice(0, 10)}`;
  const files = [];
  if (format === 'markdown' || format === 'both') {
    const fileName = `${baseName}.md`;
    fs.writeFileSync(path.join(dir, fileName), content, 'utf8');
    files.push({ path: projectFilePath(projectId, 'exports', fileName), fileName, format: 'markdown' });
  }
  if (format === 'docx' || format === 'both') {
    const fileName = `${baseName}.docx`;
    writeDocxFromMarkdown(content, path.join(dir, fileName));
    files.push({ path: projectFilePath(projectId, 'exports', fileName), fileName, format: 'docx' });
  }
  addLog(projectId, 'export', `Assembled ${files.map((file) => file.fileName).join(', ')}`);
  return { path: files[0] && files[0].path, fileName: files[0] && files[0].fileName, files, content };
}

function runGit(projectId, args, fallback = '') {
  try {
    return childProcess.execFileSync('git', ['-C', projectDir(projectId), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error((error.stderr && String(error.stderr).trim()) || error.message);
  }
}

function getGitStatus(projectId) {
  const branch = runGit(projectId, ['rev-parse', '--abbrev-ref', 'HEAD'], 'Unavailable');
  const lastCommit = runGit(projectId, ['log', '-1', '--pretty=format:%h %s (%cr)'], 'No commits found');
  const raw = runGit(projectId, ['status', '--porcelain'], '');
  const files = raw ? raw.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3)
  })) : [];
  return {
    available: branch !== 'Unavailable',
    branch,
    lastCommit,
    clean: files.length === 0,
    changed: files.filter((file) => file.status.trim() !== '??'),
    untracked: files.filter((file) => file.status.trim() === '??'),
    files
  };
}

function listRecentFiles(projectId, limit = 30) {
  const root = projectDir(projectId);
  const excluded = new Set(['.git', 'node_modules', 'snapshots']);
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (excluded.has(entry.name)) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      const stat = fs.statSync(full);
      files.push({
        path: path.relative(root, full).replace(/\\/g, '/'),
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size
      });
    });
  }
  walk(root);
  return files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, limit);
}

function getResumeSignal(projectId) {
  const file = path.join(projectDir(projectId), 'sessions', 'resume.signal');
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    content: normalizeText(fs.readFileSync(file, 'utf8')).trim(),
    modifiedAt: stat.mtime.toISOString()
  };
}

function chapterHealth(projectId, project) {
  const pendingDeltas = getCanonDeltas(projectId).filter((delta) => !['accepted', 'rejected'].includes(delta.status) && delta.applied !== true);
  return project.chapters.map((chapter) => {
    const meta = chapter.meta || {};
    const canonCount = pendingDeltas.filter((delta) => Number(delta.chapter) === Number(chapter.num)).length;
    const missing = [];
    if (!meta.summary) missing.push('summary');
    if (!meta.pov && !meta.location && !meta.timeline && !meta.purpose) missing.push('metadata');
    if (canonCount) missing.push('canon approval');
    return {
      num: chapter.num,
      title: chapter.title,
      status: chapter.status,
      words: chapter.words,
      updatedAt: chapter.updatedAt,
      summary: Boolean(meta.summary),
      metadata: Boolean(meta.pov || meta.location || meta.timeline || meta.purpose),
      pendingCanon: canonCount,
      missing
    };
  });
}

function getRunMonitor(projectId, project) {
  const recentFiles = listRecentFiles(projectId, 12)
    .filter((file) => !/^exports\//.test(file.path) && !/^snapshots\//.test(file.path));
  const latestChapter = project.chapters
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
  const pendingCanon = project.canonDeltas.filter((delta) => !['accepted', 'rejected'].includes(delta.status) && delta.applied !== true);
  const openFlags = project.flags.filter((flag) => !flag.done);
  const resumeSignal = getResumeSignal(projectId);
  const lastLog = project.logs[project.logs.length - 1] || null;
  const newestFile = recentFiles[0] || null;
  const activeCutoff = Date.now() - 10 * 60 * 1000;
  const recentlyTouched = newestFile && new Date(newestFile.modifiedAt).getTime() >= activeCutoff;
  let state = 'Watching';
  let detail = 'No recent drafting activity detected.';
  if (pendingCanon.length) {
    state = 'Needs approval';
    detail = `${pendingCanon.length} canon delta${pendingCanon.length === 1 ? '' : 's'} waiting for you.`;
  } else if (resumeSignal) {
    state = 'Resume signal pending';
    detail = resumeSignal.content || 'Claude has not consumed the resume signal yet.';
  } else if (recentlyTouched) {
    state = 'Recent activity';
    detail = newestFile.path;
  } else if (lastLog) {
    detail = `${lastLog.type}: ${lastLog.text}`;
  }
  return {
    state,
    detail,
    latestChapter: latestChapter ? {
      num: latestChapter.num,
      title: latestChapter.title,
      status: latestChapter.status,
      words: latestChapter.words,
      updatedAt: latestChapter.updatedAt
    } : null,
    pendingCanon: pendingCanon.length,
    openFlags: openFlags.length,
    resumeSignal,
    recentFiles: recentFiles.slice(0, 6),
    lastLog
  };
}

function zipFiles(files, destination) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((file) => {
    const data = fs.readFileSync(file.full);
    const compressed = zlib.deflateRawSync(data);
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const stamp = dosDateTime(fs.statSync(file.full).mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  });
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(destination, Buffer.concat([...localParts, ...centralParts, end]));
}

function createSnapshot(projectId) {
  const root = projectDir(projectId);
  const snapshotDir = path.join(root, 'snapshots');
  ensureDir(snapshotDir);
  const excluded = new Set(['.git', 'node_modules', 'snapshots', 'exports']);
  const files = [];
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (excluded.has(entry.name)) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      files.push({ full, name: path.relative(root, full) });
    });
  }
  walk(root);
  const fileName = `${slugify(projectId)}-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
  const destination = path.join(snapshotDir, fileName);
  zipFiles(files, destination);
  addLog(projectId, 'snapshot', `Created ${fileName}`);
  return {
    path: projectFilePath(projectId, 'snapshots', fileName),
    fileName,
    files: files.length,
    size: fs.statSync(destination).size
  };
}

function commitProject(projectId, message) {
  const cleaned = normalizeText(message || '').trim();
  if (!cleaned) throw new Error('Commit message is required');
  runGit(projectId, ['add', '-A', '.'], undefined);
  const before = getGitStatus(projectId);
  if (before.clean) throw new Error('No changes to commit');
  runGit(projectId, ['commit', '-m', cleaned], undefined);
  return getGitStatus(projectId);
}

function getSafety(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const bible = getBible(projectId);
  const health = getBibleHealth(projectId);
  return {
    root: ROOT,
    projectPath: projectDir(projectId),
    discordConfigured: Boolean(envValue('DISCORD_WEBHOOK_URL')),
    bibleFound: bible.found,
    chapterCount: project.chapters.length,
    plannedCount: project.planned.length,
    openFlags: project.flags.filter((flag) => !flag.done).length,
    openCanonDeltas: health.counts.openDeltas,
    missingSummaries: health.counts.missingSummaries,
    missingMetadata: health.counts.missingMetadata,
    git: getGitStatus(projectId),
    recentFiles: listRecentFiles(projectId),
    scannedAt: new Date().toISOString()
  };
}

function searchProject(projectId, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const buckets = Object.values(project.files).flat();
  return buckets.flatMap((file) => {
    const full = resolveRelativeFile(file.path);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    return lines.map((line, index) => ({ line, index })).filter(({ line }) => line.toLowerCase().includes(q)).map(({ line, index }) => ({
      file: file.name,
      path: file.path,
      line: index + 1,
      text: line.trim().slice(0, 240)
    }));
  }).slice(0, 100);
}

function chapterByNumber(project, number) {
  const num = Number(number || 1);
  return project.chapters.find((chapter) => chapter.num === num) || project.planned.find((chapter) => chapter.num === num) || null;
}

function readChapterText(projectId, chapter) {
  if (!chapter || !chapter.file) return '';
  const file = path.join(projectDir(projectId), 'manuscript', chapter.file);
  if (!fs.existsSync(file)) return '';
  return stripStatus(fs.readFileSync(file, 'utf8')).trim();
}

function excerpt(text, limit = 1200, fromEnd = false) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return fromEnd ? clean.slice(clean.length - limit) : clean.slice(0, limit);
}

function makePacket(projectId, chapterNumber, intent = 'draft') {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const bible = getBible(projectId);
  const sections = bible.sections || [];
  if (intent === 'bible-update') return makeBibleUpdatePacket(projectId, project, bible);
  if (intent === 'metadata') return makeMetadataPacket(projectId, project, bible, chapterNumber);
  const chapter = chapterByNumber(project, chapterNumber) || project.planned[0] || project.chapters[project.chapters.length - 1];
  const previous = chapter && chapter.num > 1 ? project.chapters.find((item) => item.num === chapter.num - 1) : null;
  const previousText = readChapterText(projectId, previous);
  const currentText = readChapterText(projectId, chapter);
  const openFlags = project.flags.filter((flag) => !flag.done).map((flag) => `- ${flag.text}`).join('\n') || '- None';
  const rules = bible.rules || { words: [], constructions: [] };
  const packet = [
    `# ${project.config.title} - Chapter ${chapter ? chapter.num : '?'} ${intent} packet`,
    '',
    '## Task',
    `Use this packet with any LLM. The model is a drafting/editing worker. The book machine and repo are the source of truth.`,
    `Intent: ${intent}`,
    '',
    '## Chapter Target',
    `Chapter: ${chapter ? chapter.num : '?'}`,
    `Beat: ${chapter && chapter.beat ? chapter.beat : 'No beat recorded yet.'}`,
    `Status: ${chapter ? chapter.status : 'planned'}`,
    '',
    '## North Star',
    sectionText(sections, /North Star Sentence/i, project.config.premise || 'No north star found.'),
    '',
    '## Voice And Style',
    sectionText(sections, /POV and Tense/i),
    sectionText(sections, /Prose Texture/i),
    sectionText(sections, /Unreliability Rule/i),
    '',
    '## Relevant Canon',
    sectionText(sections, /Holdfast$/i),
    sectionText(sections, /Senna Holt/i),
    sectionText(sections, /Emra Hollis/i),
    sectionText(sections, /What Is Actually True/i),
    sectionText(sections, /What Senna Believes/i),
    sectionText(sections, /What Emra Is Concealing/i),
    '',
    '## Writing Rules',
    sectionText(sections, /Before Writing Any Scene/i),
    sectionText(sections, /When in Doubt/i),
    sectionText(sections, /What Claude Code Must Never Do/i),
    '',
    '## Banned Words',
    rules.words.slice(0, 80).map((item) => `- ${item}`).join('\n') || '- None extracted',
    '',
    '## Banned Constructions',
    rules.constructions.slice(0, 80).map((item) => `- ${item}`).join('\n') || '- None extracted',
    '',
    '## Open Flags',
    openFlags,
    '',
    '## Previous Chapter Ending',
    previous ? excerpt(previousText, 1400, true) : 'No previous chapter.',
    '',
    '## Current Chapter Draft',
    currentText ? excerpt(currentText, 1800) : 'No draft exists yet.',
    '',
    '## Output Contract',
    '- Stay inside the established POV and tense.',
    '- Preserve canon and unresolved ambiguity.',
    '- Do not explain what the prose can demonstrate.',
    '- If a decision requires Alex, write a FLAG: line instead of inventing canon.',
    '- End with a short session note: what changed, open risks, next move.'
  ].filter((part) => part !== '').join('\n');
  return { content: normalizeText(packet), chapter, bibleFound: bible.found };
}

function makeMetadataPacket(projectId, project, bible, chapterNumber) {
  const sections = bible.sections || [];
  const chapter = chapterByNumber(project, chapterNumber) || project.chapters[0] || project.planned[0];
  const previous = chapter && chapter.num > 1 ? project.chapters.find((item) => item.num === chapter.num - 1) : null;
  const chapterText = readChapterText(projectId, chapter);
  const previousText = readChapterText(projectId, previous);
  const content = [
    `# ${project.config.title} - Chapter ${chapter ? chapter.num : '?'} metadata packet`,
    '',
    '## Task',
    'Read the chapter and return ONLY valid JSON matching the schema below. Do not wrap it in Markdown. Do not add commentary.',
    '',
    '## Chapter Context',
    `Chapter: ${chapter ? chapter.num : '?'}`,
    `Beat: ${chapter && chapter.beat ? chapter.beat : 'No beat recorded.'}`,
    `Status: ${chapter ? chapter.status : 'planned'}`,
    '',
    '## North Star',
    sectionText(sections, /North Star Sentence/i, project.config.premise || ''),
    '',
    '## POV / Voice Constraints',
    sectionText(sections, /POV and Tense/i),
    sectionText(sections, /Unreliability Rule/i),
    '',
    '## Previous Chapter Ending',
    previous ? excerpt(previousText, 1200, true) : 'No previous chapter.',
    '',
    '## Chapter Text',
    chapterText ? excerpt(chapterText, 12000) : 'No draft exists yet. If no draft exists, infer only from the beat and leave uncertain fields empty.',
    '',
    '## JSON Schema',
    JSON.stringify({
      chapter: chapter ? chapter.num : null,
      summary: '5-8 sentence durable plot summary.',
      pov: 'POV character name.',
      location: 'Primary location.',
      timeline: 'Story day/time marker if known.',
      purpose: 'What this chapter does structurally.',
      emotionalTurn: 'Emotional state shift from start to end.',
      heatLevel: 0,
      horrorLevel: 0,
      canonIntroduced: 'New facts introduced as canon.',
      continuityRisks: 'Contradictions, open questions, or things to check.',
      revisionNotes: 'Suggested next revision pass notes.',
      startState: 'Character/situation state at chapter opening.',
      endState: 'Character/situation state at chapter close.',
      nextMove: 'Most useful next action.',
      readiness: 'needs-review',
      canonDeltas: [{ category: 'character|setting|timeline|unreliability|relationship|plot|ending|general', text: 'candidate canon update' }],
      flags: ['questions only Alex should answer']
    }, null, 2),
    '',
    '## Constraints',
    '- Use empty strings for unknown fields.',
    '- heatLevel and horrorLevel must be numbers from 0 to 5.',
    '- readiness must be one of: needs-review, ready-for-llm, blocked, needs-alex, done.',
    '- canonDeltas should include only facts that may need the bible updated.',
    '- flags should include only decisions requiring Alex.'
  ].join('\n');
  return { content: normalizeText(content), chapter, bibleFound: bible.found };
}

function makeBibleUpdatePacket(projectId, project, bible) {
  const health = getBibleHealth(projectId);
  const deltas = getCanonDeltas(projectId).filter((item) => !['accepted', 'rejected'].includes(item.status));
  const content = [
    `# ${project.config.title} - Bible update packet`,
    '',
    '## Task',
    'Use this packet to update the project bible or prepare exact bible edits. Do not invent canon. Resolve only the listed candidates and health issues.',
    '',
    '## Bible',
    `File: ${bible.file || 'Not found'}`,
    `Stale: ${health.staleBible ? 'yes' : 'no'}`,
    '',
    '## Open Canon Deltas',
    deltas.length ? deltas.map((item) => `- [${item.status}] Chapter ${item.chapter || '?'} / ${item.category}: ${item.text}${item.targetSection ? ` (target: ${item.targetSection})` : ''}`).join('\n') : '- None',
    '',
    '## Placeholders',
    health.placeholders.length ? health.placeholders.map((item) => `- ${item.text}`).join('\n') : '- None',
    '',
    '## Missing Chapter Summaries',
    health.missingSummaries.length ? health.missingSummaries.map((num) => `- Chapter ${num}`).join('\n') : '- None',
    '',
    '## Open Flags',
    health.openFlags.length ? health.openFlags.map((flag) => `- ${flag.text}`).join('\n') : '- None',
    '',
    '## Output Contract',
    '- Return proposed bible edits by section.',
    '- Preserve voice, ending constraints, and unreliability rules.',
    '- Mark anything requiring Alex as FLAG: instead of deciding it.',
    '- Do not rewrite unrelated bible sections.'
  ].join('\n');
  return { content: normalizeText(content), chapter: null, bibleFound: bible.found };
}

function savePacket(projectId, chapterNumber, intent = 'draft') {
  const packet = makePacket(projectId, chapterNumber, intent);
  const chapter = packet.chapter;
  const name = `packet-chapter-${String(chapter ? chapter.num : chapterNumber).padStart(2, '0')}-${slugify(intent)}.md`;
  const file = path.join(projectDir(projectId), 'sessions', name);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, packet.content, 'utf8');
  addLog(projectId, 'packet', `Generated ${name}`);
  return { ...packet, path: projectFilePath(projectId, 'sessions', name), fileName: name };
}

function saveSession(projectId, input) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const chapterNumber = Number(input.chapter || 1);
  const intent = input.intent || 'draft';
  const stamp = nowStamp();
  const safeStamp = stamp.replace(/[^0-9]+/g, '-').replace(/-$/, '');
  const fileName = `session-chapter-${String(chapterNumber).padStart(2, '0')}-${slugify(intent)}-${safeStamp}.md`;
  const summary = normalizeText(input.summary || '').trim();
  const nextMove = normalizeText(input.nextMove || '').trim();
  const filesTouched = normalizeText(input.filesTouched || '').trim();
  const notes = [
    `# Session - Chapter ${chapterNumber} - ${intent}`,
    '',
    `Time: ${stamp}`,
    `Project: ${project.config.title}`,
    '',
    '## Summary',
    summary || 'No summary recorded.',
    '',
    '## Files Touched',
    filesTouched || 'Not recorded.',
    '',
    '## Next Move',
    nextMove || 'Not recorded.'
  ].join('\n');
  const file = path.join(projectDir(projectId), 'sessions', fileName);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, notes, 'utf8');
  const metaPatch = input.meta && typeof input.meta === 'object' ? input.meta : {};
  if (summary && !metaPatch.summary) metaPatch.summary = summary;
  if (nextMove && !metaPatch.nextMove) metaPatch.nextMove = nextMove;
  const meta = saveChapterMeta(projectId, chapterNumber, metaPatch);
  (input.flags || []).filter(Boolean).forEach((flag) => addFlag(projectId, flag));
  (input.canonDeltas || []).filter(Boolean).forEach((delta) => {
    if (typeof delta === 'string') addCanonDelta(projectId, { chapter: chapterNumber, text: delta });
    else addCanonDelta(projectId, { chapter: chapterNumber, ...delta });
  });
  if (input.savePacket) savePacket(projectId, chapterNumber, intent);
  addLog(projectId, 'session', `Recorded ${fileName}`);
  return { path: projectFilePath(projectId, 'sessions', fileName), fileName, meta };
}

function splitRuleTerms(items) {
  return items.flatMap((item) => String(item || '').split(/\s+\/\s+| \/ |;|,/))
    .map((item) => item.replace(/\(.+?\)/g, '').trim())
    .filter((item) => item.length > 2 && item.length < 80);
}

function scanTextForRules(text, rules) {
  const findings = [];
  const source = String(text || '');
  const lower = source.toLowerCase();
  splitRuleTerms(rules.words || []).forEach((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'ig');
    const matches = source.match(re);
    if (matches) findings.push({ type: 'word', rule: word, count: matches.length });
  });
  splitRuleTerms(rules.constructions || []).forEach((phrase) => {
    const needle = phrase.toLowerCase();
    if (needle.length > 3 && lower.includes(needle)) {
      findings.push({ type: 'construction', rule: phrase, count: lower.split(needle).length - 1 });
    }
  });
  const dashCount = (source.match(/[—–]/g) || []).length;
  if (dashCount) findings.push({ type: 'punctuation', rule: 'em/en dash', count: dashCount });
  return findings;
}

function scanRules(projectId, relPath = '') {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const bible = getBible(projectId);
  const files = relPath
    ? [{ path: relPath, name: path.basename(relPath) }]
    : project.chapters.map((chapter) => ({ path: chapter.path, name: chapter.file }));
  const results = files.map((file) => {
    const full = resolveRelativeFile(file.path);
    const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    return {
      file: file.name,
      path: file.path,
      findings: scanTextForRules(stripStatus(text), bible.rules || { words: [], constructions: [] })
    };
  });
  return { bibleFound: bible.found, results, totalFindings: results.reduce((sum, item) => sum + item.findings.length, 0) };
}

function updateConfig(projectId, patch) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  const next = { ...project.config };
  ['title', 'premise', 'status', 'penName'].forEach((key) => {
    if (patch[key] !== undefined) next[key] = String(patch[key]);
  });
  if (patch.targetWords !== undefined) next.targetWords = Number(patch.targetWords || next.targetWords);
  if (patch.chapters !== undefined) next.chapters = Number(patch.chapters || next.chapters);
  if (patch.beats && typeof patch.beats === 'object') next.beats = { ...(next.beats || {}), ...patch.beats };
  writeJson(configPath(projectId), next);
  addLog(projectId, 'update', 'Project brief updated');
}

function addFlag(projectId, text) {
  const file = path.join(projectDir(projectId), 'sessions', 'flags.md');
  ensureDir(path.dirname(file));
  const cleaned = normalizeText(text).trim();
  fs.appendFileSync(file, `- [ ] ${cleaned}\n`, 'utf8');
  addLog(projectId, 'flag', cleaned);
  const project = getProject(projectId);
  notifyForFlag(projectId, project && project.config.title, cleaned);
}

function toggleFlag(projectId, id) {
  if (String(id).startsWith('progress-')) {
    const progressFile = path.join(projectDir(projectId), 'sessions', 'progress.md');
    if (!fs.existsSync(progressFile)) return;
    const lines = fs.readFileSync(progressFile, 'utf8').split(/\r?\n/);
    const index = Number(String(id).replace('progress-', '')) - 1;
    if (lines[index] && /^FLAG:\s*/i.test(lines[index])) {
      lines[index] = lines[index].replace(/^FLAG:\s*/i, 'RESOLVED-FLAG: ');
      fs.writeFileSync(progressFile, lines.join('\n'), 'utf8');
      addLog(projectId, 'flag', `Progress flag ${index + 1} dismissed`);
    }
    return;
  }
  const file = path.join(projectDir(projectId), 'sessions', 'flags.md');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const index = Number(id) - 1;
  if (lines[index]) {
    lines[index] = lines[index].replace(/^- \[[ x]\]/i, lines[index].includes('[x]') || lines[index].includes('[X]') ? '- [ ]' : '- [x]');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    addLog(projectId, 'flag', `Flag ${id} updated`);
  }
}

function healthStatus() {
  const projects = getProjects();
  const settings = getSettings();
  return {
    ok: true,
    name: settings.machineName || 'Book Machine OS',
    port: PORT,
    root: ROOT,
    mode: REPO_MODE ? 'repo' : 'library',
    projects: projects.map((project) => ({ id: project.id, title: project.config.title })),
    defaultProjectId: projects.length === 1 ? projects[0].id : ''
  };
}

const MCP_TOOLS = [
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
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } }
  },
  {
    name: 'holdfast_pending_canon_deltas',
    description: 'List canon deltas still waiting for approval or resolution.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } }
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

function mcpTextContent(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function mcpPickProject(status, projectId) {
  const projects = status.projects || [];
  return projectId ? projects.find((project) => project.id === projectId) : projects[0];
}

async function callMcpTool(name, args = {}) {
  if (name === 'holdfast_health') return healthStatus();
  if (name === 'holdfast_status') {
    const status = { settings: getSettings(), root: ROOT, mode: REPO_MODE ? 'repo' : 'library', projects: getProjects() };
    const project = mcpPickProject(status, args.projectId);
    return {
      root: status.root,
      mode: status.mode,
      selectedProject: project ? {
        id: project.id,
        title: project.config && project.config.title,
        penName: project.config && project.config.penName,
        words: project.metrics && project.metrics.words,
        draftedChapters: project.chapters && project.chapters.length,
        plannedChapters: project.config && project.config.chapters,
        openFlags: (project.flags || []).filter((flag) => !flag.done),
        pendingCanonDeltas: (project.canonDeltas || []).filter((delta) => !['accepted', 'rejected'].includes(delta.status)),
        nextMove: project.nextMove,
        runMonitor: project.runMonitor,
        chapterHealth: project.chapterHealth
      } : null,
      projects: status.projects.map((item) => ({
        id: item.id,
        title: item.config && item.config.title,
        words: item.metrics && item.metrics.words,
        draftedChapters: item.chapters && item.chapters.length
      }))
    };
  }
  if (name === 'holdfast_context') {
    return buildAiContext(args.projectId, {
      mode: args.mode || 'chapter',
      chapter: args.chapter,
      includeText: args.includeText === true || args.includeText === '1',
      textLimit: Number(args.textLimit || 5000)
    });
  }
  if (name === 'holdfast_packet') return makePacket(args.projectId, args.chapter, args.intent || 'draft');
  if (name === 'holdfast_open_flags') {
    const status = { projects: getProjects() };
    const project = mcpPickProject(status, args.projectId);
    return { projectId: project && project.id, flags: project ? (project.flags || []).filter((flag) => !flag.done) : [] };
  }
  if (name === 'holdfast_pending_canon_deltas') {
    const projectId = resolveProjectId(args.projectId);
    return { projectId, deltas: getCanonDeltas(projectId).filter((delta) => !['accepted', 'rejected'].includes(delta.status)) };
  }
  if (name === 'holdfast_submit_chapter_metadata') {
    return importChapterMetadata(args.projectId, args.chapter, { projectId: args.projectId, chapter: args.chapter, content: args.content });
  }
  if (name === 'holdfast_submit_canon_delta') return { delta: addCanonDelta(resolveProjectId(args.projectId), args) };
  if (name === 'holdfast_review_canon_delta') return reviewCanonDelta(resolveProjectId(args.projectId), args.id, args.action);
  if (name === 'holdfast_create_project') return { project: createProject(args) };
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcpMessage(message) {
  if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC message');
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params && message.params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO
      }
    };
  }
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: MCP_TOOLS } };
  if (message.method === 'tools/call') {
    const params = message.params || {};
    const result = await callMcpTool(params.name, params.arguments || {});
    return { jsonrpc: '2.0', id: message.id, result: { content: mcpTextContent(result) } };
  }
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Unsupported MCP method: ${message.method}` }
  };
}

function mcpRequestAuthorized(req) {
  const token = envValue('MCP_AUTH_TOKEN');
  if (!token) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const supplied = bearer ? bearer[1].trim() : url.searchParams.get('token') || req.headers['x-holdfast-token'] || '';
  return supplied === token;
}

async function handleMcpHttp(req, res) {
  if (!mcpRequestAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer realm="Holdfast MCP"'
    });
    res.end(JSON.stringify({ error: 'MCP auth token required' }));
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Use POST for MCP JSON-RPC messages.' }));
    return;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readBody(req);
    const response = await handleMcpMessage(body);
    const sessionHeaders = body && body.method === 'initialize' ? { 'Mcp-Session-Id': `holdfast-${Date.now().toString(36)}` } : {};
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...sessionHeaders
    });
    res.end(JSON.stringify(response));
  } catch (error) {
    send(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: error.message }
    });
  }
}

async function api(req, res, url) {
  const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await readBody(req) : {};
  if (url.pathname === '/api/health' || url.pathname === '/api/dashboard/status') return send(res, 200, healthStatus());
  if (url.pathname === '/api/status') {
    return send(res, 200, { settings: getSettings(), root: ROOT, mode: REPO_MODE ? 'repo' : 'library', projects: getProjects() });
  }
  if (url.pathname === '/api/cover' && req.method === 'GET') {
    const projectId = resolveProjectId(url.searchParams.get('projectId'));
    const looseProject = getLooseProject(projectId);
    const cover = looseProject && looseProject.loose ? findLooseCover(looseProject.loose.dir) : findCoverFile(projectDir(projectId));
    if (!cover) return send(res, 404, { error: 'Cover not found' });
    res.writeHead(200, {
      'Content-Type': coverMimeType(cover.path),
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(cover.path).pipe(res);
    return;
  }
  if (url.pathname === '/api/settings' && req.method === 'PUT') return send(res, 200, { settings: updateSettings(body.settings || body) });
  if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, getAppConfig());
  if (url.pathname === '/api/config' && req.method === 'PUT') return send(res, 200, writeEnvConfig(body.config || body));
  if (url.pathname === '/api/claude/jobs' && req.method === 'GET') return send(res, 200, { jobs: getClaudeJobs(url.searchParams.get('projectId')) });
  if (url.pathname === '/api/claude/run' && req.method === 'POST') return send(res, 200, { job: startClaudeJob(body) });
  if (url.pathname === '/api/claude/cancel' && req.method === 'POST') return send(res, 200, { job: cancelClaudeJob(body.id) });
  if (url.pathname === '/api/project' && req.method === 'POST') return send(res, 200, { project: createProject(body) });
  if (url.pathname === '/api/project' && req.method === 'PUT') {
    updateConfig(body.projectId, body.patch || {});
    return send(res, 200, { project: getProject(body.projectId) });
  }
  if (url.pathname === '/api/chapter' && req.method === 'POST') {
    return send(res, 200, createChapter(body.projectId, body.number, body.title));
  }
  if (url.pathname === '/api/chapter/meta' && req.method === 'POST') {
    const projectId = resolveProjectId(body.projectId || url.searchParams.get('projectId'));
    return send(res, 200, { meta: saveChapterMeta(projectId, body.chapter || url.searchParams.get('chapter'), body.meta || body.metadata || {}) });
  }
  if (url.pathname === '/api/chapter/meta/import' && req.method === 'POST') {
    return send(res, 200, importChapterMetadata(body.projectId || url.searchParams.get('projectId'), body.chapter || url.searchParams.get('chapter'), body));
  }
  if (url.pathname === '/api/chapter/gate' && req.method === 'POST') {
    return send(res, 200, { meta: toggleQualityGate(body.projectId, body.chapter, body.gate, body.value) });
  }
  if (url.pathname === '/api/session' && req.method === 'POST') {
    return send(res, 200, saveSession(body.projectId, body));
  }
  if (url.pathname === '/api/stage' && req.method === 'POST') {
    updateStage(body.projectId, body.file, body.stage);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/file' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    if (String(rel).replace(/\\/g, '/').startsWith(`${LOOSE_DOCX_PREFIX}/`)) {
      return send(res, 200, readLooseChapter(rel));
    }
    const full = resolveRelativeFile(rel);
    if (!fs.existsSync(full)) return send(res, 404, { error: 'File not found' });
    const content = fs.readFileSync(full, 'utf8');
    return send(res, 200, { path: rel, content, words: wordCount(stripStatus(content)) });
  }
  if (url.pathname === '/api/file' && req.method === 'POST') {
    saveRelativeFile(body.path, body.content);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/export' && req.method === 'POST') return send(res, 200, exportProject(body.projectId));
  if (url.pathname === '/api/assemble' && req.method === 'POST') return send(res, 200, assembleExport(body.projectId, body.options || {}));
  if (url.pathname === '/api/context' && req.method === 'GET') {
    return send(res, 200, buildAiContext(url.searchParams.get('projectId'), {
      mode: url.searchParams.get('mode') || 'chapter',
      chapter: url.searchParams.get('chapter'),
      includeText: url.searchParams.get('includeText') === '1',
      textLimit: Number(url.searchParams.get('textLimit') || 5000)
    }));
  }
  if (url.pathname === '/api/ai/run' && req.method === 'POST') return send(res, 200, await runAiTask(body));
  if (url.pathname === '/api/ai/save' && req.method === 'POST') return send(res, 200, saveAiResponse(body.projectId, body.title, body.content));
  if (url.pathname === '/api/openrouter/models') {
    return send(res, 200, await getOpenRouterModels({
      q: url.searchParams.get('q') || '',
      sort: url.searchParams.get('sort') || 'popular',
      family: url.searchParams.get('family') || '',
      free: url.searchParams.get('free') === '1',
      refresh: url.searchParams.get('refresh') === '1'
    }));
  }
  if (url.pathname === '/api/safety') return send(res, 200, getSafety(url.searchParams.get('projectId')));
  if (url.pathname === '/api/snapshot' && req.method === 'POST') return send(res, 200, createSnapshot(body.projectId));
  if (url.pathname === '/api/git/commit' && req.method === 'POST') return send(res, 200, commitProject(body.projectId, body.message));
  if (url.pathname === '/api/search') return send(res, 200, { results: searchProject(url.searchParams.get('projectId'), url.searchParams.get('q')) });
  if (url.pathname === '/api/bible') return send(res, 200, getBible(url.searchParams.get('projectId')));
  if (url.pathname === '/api/bible/health') return send(res, 200, getBibleHealth(url.searchParams.get('projectId')));
  if (url.pathname === '/api/bible/cleanup' && req.method === 'GET') return send(res, 200, getBibleCleanup(url.searchParams.get('projectId')));
  if (url.pathname === '/api/bible/cleanup' && req.method === 'PUT') return send(res, 200, updateBibleCleanup(body.projectId, body.id, body.patch || {}));
  if (url.pathname === '/api/bible/cleanup/packet') return send(res, 200, makeBibleCleanupPacket(url.searchParams.get('projectId')));
  if (url.pathname === '/api/bible/cleanup/apply' && req.method === 'POST') return send(res, 200, applyBibleCleanup(body.projectId));
  if (url.pathname === '/api/editor-returns' && req.method === 'GET') return send(res, 200, { returns: getEditorReturns(url.searchParams.get('projectId')) });
  if (url.pathname === '/api/editor-returns' && req.method === 'POST') return send(res, 200, saveEditorReturn(body.projectId, body.return || body));
  if (url.pathname === '/api/readiness') return send(res, 200, getReadiness(url.searchParams.get('projectId')));
  if (url.pathname === '/api/canon-deltas' && req.method === 'GET') return send(res, 200, { deltas: getCanonDeltas(url.searchParams.get('projectId')) });
  if (url.pathname === '/api/canon-deltas' && req.method === 'POST') return send(res, 200, { delta: addCanonDelta(body.projectId, body) });
  if (url.pathname === '/api/canon-deltas' && req.method === 'PUT') return send(res, 200, { delta: updateCanonDelta(body.projectId, body.id, body.patch || {}) });
  if (url.pathname === '/api/canon-deltas/review' && req.method === 'POST') return send(res, 200, reviewCanonDelta(body.projectId, body.id, body.action));
  if (url.pathname === '/api/packet' && req.method === 'GET') {
    return send(res, 200, makePacket(url.searchParams.get('projectId'), url.searchParams.get('chapter'), url.searchParams.get('intent') || 'draft'));
  }
  if (url.pathname === '/api/packet' && req.method === 'POST') {
    return send(res, 200, savePacket(body.projectId, body.chapter, body.intent || 'draft'));
  }
  if (url.pathname === '/api/rules') {
    return send(res, 200, scanRules(url.searchParams.get('projectId'), url.searchParams.get('path') || ''));
  }
  if (url.pathname === '/api/flag' && req.method === 'POST') {
    addFlag(body.projectId, body.text);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/flag/toggle' && req.method === 'POST') {
    toggleFlag(body.projectId, body.id);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Unknown endpoint' });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = safeJoin(PUBLIC, decodeURIComponent(pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
  send(res, 200, fs.readFileSync(file), types[ext] || 'application/octet-stream');
}

async function handleLogin(req, res) {
  if (req.method === 'GET') {
    if (webRequestAuthorized(req)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return send(res, 200, loginPage(), 'text/html');
  }
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
  const form = parseForm(await readRawBody(req));
  const email = normalizeText(form.email).trim().toLowerCase();
  const password = String(form.password || '');
  const expectedEmail = envValue('WEB_AUTH_EMAIL').toLowerCase();
  const passwordHash = envValue('WEB_AUTH_PASSWORD_HASH');
  if (email && email === expectedEmail && verifyPassword(password, passwordHash)) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    webSessions.set(sessionId, { email, expires: Date.now() + 12 * 60 * 60 * 1000 });
    setSessionCookie(req, res, sessionId);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  return send(res, 401, loginPage('Invalid email or password.'), 'text/html');
}

function handleLogout(req, res) {
  const sessionId = parseCookies(req).holdfast_session;
  if (sessionId) webSessions.delete(sessionId);
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/login' });
  res.end();
}

function requireWebAuth(req, res, url) {
  if (webRequestAuthorized(req)) return true;
  if (url.pathname.startsWith('/api/')) {
    send(res, 401, { error: 'Login required' });
    return false;
  }
  res.writeHead(302, { Location: '/login' });
  res.end();
  return false;
}

initLibrary();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/health') return send(res, 200, healthStatus());
    if (url.pathname === '/mcp') return await handleMcpHttp(req, res);
    if (url.pathname === '/login') return await handleLogin(req, res);
    if (url.pathname === '/logout') return handleLogout(req, res);
    if (!requireWebAuth(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`${getSettings().machineName || 'Book Machine OS'} running at ${address}`);
  console.log(`Library: ${ROOT}`);
  console.log(`Discord notifications: ${envValue('DISCORD_WEBHOOK_URL') ? 'enabled' : 'not configured'}`);
  try {
    seedExistingFlags();
    notifyTimer = setInterval(() => {
      try {
        scanForNewFlags();
      } catch (error) {
        console.log('Flag scan failed:', error.message);
      }
    }, 5000);
  } catch (error) {
    console.log('Flag notification setup failed:', error.message);
  }
  if (process.env.HOLDFAST_NO_OPEN !== '1') {
    const command = process.platform === 'win32' ? `start ${address}` : process.platform === 'darwin' ? `open ${address}` : `xdg-open ${address}`;
    setTimeout(() => childProcess.exec(command, () => {}), 500);
  }
});

server.on('close', () => {
  if (notifyTimer) clearInterval(notifyTimer);
});

module.exports = { server, ROOT };
