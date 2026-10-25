'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT = 3000;
const SERVER_DIR = path.join(__dirname, 'mc_server');
const PLUGINS_DIR = path.join(SERVER_DIR, 'plugins');
const GEYSER_CONF_DIR = path.join(PLUGINS_DIR, 'Geyser-Spigot');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── Global State ─────────────────────────────────────────────────────────────
let mcProcess = null;
let serverStatus = 'offline'; // offline | starting | online
let onlinePlayers = [];       // [{name, platform, ping}]
let selectedVersion = { version: '1.21.4', engine: 'paper', ramMb: 4096 };
let playitTunnels = { pc: '', pe: '' };

// ─── WebSocket Clients ────────────────────────────────────────────────────────
const clients = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, code, obj) {
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendError(res, code, msg) {
  sendJson(res, code, { ok: false, error: msg });
}

// ─── WebSocket Frame Encoder ───────────────────────────────────────────────────
function encodeWsFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(data) {
  const json = JSON.stringify(data);
  const buf = encodeWsFrame(json);
  clients.forEach(s => {
    try { s.write(buf); } catch (e) { clients.delete(s); }
  });
}

// ─── Download / Fetch Utilities ───────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    ensureDir(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    proto.get(url, { headers: { 'User-Agent': 'MineYou-M3/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(() => fs.unlink(destPath, () => {}));
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(destPath, () => {}));
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'MineYou-M3/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchJson(redirectUrl).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Directory Scanner ────────────────────────────────────────────────────────
function scanDir(dir, baseDir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (item.isDirectory()) {
      results.push({ name: item.name, relativePath, size: 0, isDir: true });
      results.push(...scanDir(fullPath, baseDir));
    } else {
      const stat = fs.statSync(fullPath);
      results.push({ name: item.name, relativePath, size: stat.size, isDir: false });
    }
  }
  return results;
}

// ─── Aikar's Flags ────────────────────────────────────────────────────────────
function aikarFlags(ramMb) {
  return [
    `-Xms${ramMb}M`,
    `-Xmx${ramMb}M`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
  ];
}

// ─── server.properties Generator ─────────────────────────────────────────────
function generateServerProperties(opts) {
  const {
    motd = 'A MineYou M3 Server',
    maxPlayers = 20,
    gamemode = 'survival',
    difficulty = 'normal',
    crackPc = false,
  } = opts;
  return [
    `#Minecraft server properties`,
    `online-mode=${crackPc ? 'false' : 'true'}`,
    `max-players=${maxPlayers}`,
    `motd=${motd}`,
    `gamemode=${gamemode}`,
    `difficulty=${difficulty}`,
    `view-distance=8`,
    `simulation-distance=6`,
    `enforce-secure-profile=false`,
    `allow-flight=true`,
    `spawn-protection=0`,
    `level-type=minecraft\\:normal`,
    `pvp=true`,
    `enable-command-block=true`,
    `server-port=25565`,
    ``,
  ].join('\n');
}

// ─── Geyser config.yml Generator ─────────────────────────────────────────────
function generateGeyserConfig(opts) {
  const {
    floodgatePe = false,
    motd = 'A MineYou M3 Server',
  } = opts;
  return `bedrock:
  port: 19132
  clone-remote-port: false
  motd1: "${motd}"
  motd2: "MineYou M3"
  server-name: "MineYou M3"
remote:
  address: auto
  port: 25565
  auth-type: ${floodgatePe ? 'floodgate' : 'online'}
above-bedrock-nether-building: true
emote-offhand-workaround: disabled
metrics:
  enabled: false
`;
}

// ─── start_server.bat Generator ───────────────────────────────────────────────
function generateStartBat(version, ramMb) {
  const flags = aikarFlags(ramMb).join(' ');
  return `@echo off
title MineYou M3 - Minecraft Server
cd /d "%~dp0"
java ${flags} -jar paper-${version}.jar --nogui
pause
`;
}

// ─── Modrinth helper ─────────────────────────────────────────────────────────
async function downloadModrinth(projectSlug, destPath) {
  const versions = await fetchJson(`https://api.modrinth.com/v2/project/${projectSlug}/version`);
  if (!Array.isArray(versions) || versions.length === 0) throw new Error(`No versions found for ${projectSlug}`);
  const first = versions[0];
  const fileEntry = first.files && first.files[0];
  if (!fileEntry || !fileEntry.url) throw new Error(`No file URL for ${projectSlug}`);
  await downloadFile(fileEntry.url, destPath);
}

async function getPaperDownloadUrl(version) {
  // 1. Thử PaperMC v3 (Fill API mới nhất)
  try {
    const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
    if (Array.isArray(builds) && builds.length > 0) {
      const build = builds.find(b => b.channel === 'STABLE') || builds[0];
      const dl = build.downloads && (build.downloads['server:default'] || Object.values(build.downloads)[0]);
      if (dl && dl.url) {
        return { url: dl.url, buildId: build.id };
      }
    }
  } catch (e) {
    console.error('Fill v3 API error:', e.message);
  }

  // 2. Fallback sang v2 nếu có
  try {
    const paperMeta = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
    if (paperMeta && Array.isArray(paperMeta.builds) && paperMeta.builds.length > 0) {
      const latestBuild = paperMeta.builds[paperMeta.builds.length - 1];
      return {
        url: `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}/downloads/paper-${version}-${latestBuild}.jar`,
        buildId: latestBuild
      };
    }
  } catch (e) {}

  throw new Error(`Không tìm thấy build khả dụng cho PaperMC phiên bản ${version}`);
}

// ─── Build Resource Handler ───────────────────────────────────────────────────
async function handleBuild(body, res) {
  const {
    version = '1.21.4',
    engine = 'paper',
    ramMb = 4096,
    includeGeyser = false,
    includeVia = false,
    includeSkins = false,
    includePlayit = false,
    motd = 'A MineYou M3 Server',
    maxPlayers = 20,
    gamemode = 'survival',
    difficulty = 'normal',
    crackPc = false,
    floodgatePe = false,
  } = body;

  try {
    // ── Step 1 (20%) — Create dirs, download PaperMC ─────────────────────────
    broadcast({ type: 'build_progress', step: 1, percent: 5, message: 'Đang tạo thư mục...' });
    ensureDir(SERVER_DIR);
    ensureDir(PLUGINS_DIR);
    ensureDir(GEYSER_CONF_DIR);

    broadcast({ type: 'build_progress', step: 1, percent: 10, message: 'Đang lấy thông tin PaperMC...' });
    const { url: paperUrl, buildId } = await getPaperDownloadUrl(version);

    broadcast({ type: 'build_progress', step: 1, percent: 15, message: `Đang tải PaperMC ${version} build #${buildId}...` });
    const paperJarName = `paper-${version}.jar`;
    await downloadFile(paperUrl, path.join(SERVER_DIR, paperJarName));
    broadcast({ type: 'build_progress', step: 1, percent: 20, message: 'Tải PaperMC hoàn tất.' });

    // ── Step 2 (45%) — Download Plugins ──────────────────────────────────────
    broadcast({ type: 'build_progress', step: 2, percent: 25, message: 'Đang tải plugins...' });

    if (includeGeyser) {
      broadcast({ type: 'build_progress', step: 2, percent: 27, message: 'Đang tải Geyser-Spigot...' });
      await downloadFile(
        'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
        path.join(PLUGINS_DIR, 'Geyser-Spigot.jar')
      );
      broadcast({ type: 'build_progress', step: 2, percent: 32, message: 'Đang tải Floodgate-Spigot...' });
      await downloadFile(
        'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
        path.join(PLUGINS_DIR, 'floodgate-spigot.jar')
      );
    }

    if (includeVia) {
      broadcast({ type: 'build_progress', step: 2, percent: 35, message: 'Đang tải ViaVersion...' });
      await downloadModrinth('viaversion', path.join(PLUGINS_DIR, 'ViaVersion.jar'));
      broadcast({ type: 'build_progress', step: 2, percent: 39, message: 'Đang tải ViaBackwards...' });
      await downloadModrinth('viabackwards', path.join(PLUGINS_DIR, 'ViaBackwards.jar'));
    }

    if (includeSkins) {
      broadcast({ type: 'build_progress', step: 2, percent: 42, message: 'Đang tải SkinsRestorer...' });
      await downloadModrinth('skinsrestorer', path.join(PLUGINS_DIR, 'SkinsRestorer.jar'));
    }

    if (includePlayit) {
      broadcast({ type: 'build_progress', step: 2, percent: 44, message: 'Đang tải playit-minecraft-plugin...' });
      await downloadFile(
        'https://github.com/playit-cloud/playit-minecraft-plugin/releases/latest/download/playit-minecraft-plugin.jar',
        path.join(PLUGINS_DIR, 'playit-minecraft-plugin.jar')
      );
    }

    broadcast({ type: 'build_progress', step: 2, percent: 45, message: 'Tải plugins hoàn tất.' });

    // ── Step 3 (70%) — Generate config files ─────────────────────────────────
    broadcast({ type: 'build_progress', step: 3, percent: 55, message: 'Đang sinh file cấu hình...' });

    fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), 'eula=true\n', 'utf8');
    fs.writeFileSync(
      path.join(SERVER_DIR, 'server.properties'),
      generateServerProperties({ motd, maxPlayers, gamemode, difficulty, crackPc }),
      'utf8'
    );

    broadcast({ type: 'build_progress', step: 3, percent: 70, message: 'Sinh file cấu hình hoàn tất.' });

    // ── Step 4 (90%) — Geyser config + start_server.bat ──────────────────────
    broadcast({ type: 'build_progress', step: 4, percent: 78, message: 'Đang sinh Geyser config...' });

    if (includeGeyser) {
      ensureDir(GEYSER_CONF_DIR);
      fs.writeFileSync(
        path.join(GEYSER_CONF_DIR, 'config.yml'),
        generateGeyserConfig({ floodgatePe, motd }),
        'utf8'
      );
    }

    broadcast({ type: 'build_progress', step: 4, percent: 85, message: 'Đang sinh start_server.bat...' });
    fs.writeFileSync(
      path.join(SERVER_DIR, 'start_server.bat'),
      generateStartBat(version, ramMb),
      'utf8'
    );

    broadcast({ type: 'build_progress', step: 4, percent: 90, message: 'Sinh script khởi động hoàn tất.' });

    // ── Step 5 (100%) — Scan directory ────────────────────────────────────────
    broadcast({ type: 'build_progress', step: 5, percent: 95, message: 'Đang quét cây thư mục...' });
    const files = scanDir(SERVER_DIR, SERVER_DIR);
    broadcast({ type: 'build_done', files });
    broadcast({ type: 'build_progress', step: 5, percent: 100, message: 'Hoàn tất! Server đã sẵn sàng.' });

    sendJson(res, 200, { ok: true, files });
  } catch (err) {
    broadcast({ type: 'build_error', message: err.message });
    sendError(res, 500, err.message);
  }
}

// ─── Java Command Resolver ──────────────────────────────────────────────────
function scanForJavaExes(baseDir) {
  const list = [];
  try {
    if (fs.existsSync(baseDir)) {
      const dirs = fs.readdirSync(baseDir);
      for (const d of dirs) {
        const binJava = path.join(baseDir, d, 'bin', 'java.exe');
        if (fs.existsSync(binJava)) list.push(binJava);
      }
    }
  } catch (e) {}
  return list;
}

function getJavaCommand() {
  const candidates = [
    ...scanForJavaExes('C:\\Program Files\\Eclipse Adoptium'),
    ...scanForJavaExes('C:\\Program Files\\Java'),
    ...scanForJavaExes('C:\\Program Files\\Microsoft'),
    ...scanForJavaExes('C:\\Program Files (x86)\\Java'),
  ];
  for (const cmd of candidates) {
    if (fs.existsSync(cmd)) return cmd;
  }
  return 'java';
}

// ─── MC Process Management ────────────────────────────────────────────────────
function startMcServer(version, ramMb) {
  if (mcProcess) return;
  const jarName = `paper-${version}.jar`;
  const args = [...aikarFlags(ramMb), '-jar', jarName, '--nogui'];
  const javaCmd = getJavaCommand();

  serverStatus = 'starting';
  broadcast({ type: 'status', data: { status: 'starting' } });
  broadcast({ type: 'log', data: `[MineYou] Dùng lệnh Java: ${javaCmd}` });

  mcProcess = spawn(javaCmd, args, {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const handleLine = (line) => {
    line = line.toString().trim();
    if (!line) return;
    broadcast({ type: 'log', data: line });

    // Detect server ready
    if (/Done \(/.test(line) || /\[Server thread\/INFO\].*Done/.test(line)) {
      serverStatus = 'online';
      broadcast({ type: 'status', data: { status: 'online' } });
    }

    // Player join
    const joinMatch = line.match(/([A-Za-z0-9_]+) joined the game/);
    if (joinMatch) {
      const name = joinMatch[1];
      const platform = name.startsWith('.') ? 'Mobile' : 'PC';
      if (!onlinePlayers.find(p => p.name === name)) {
        onlinePlayers.push({ name, platform, ping: 0 });
        broadcast({ type: 'players', data: onlinePlayers });
      }
    }

    // Player leave
    const leaveMatch = line.match(/([A-Za-z0-9_]+) left the game/);
    if (leaveMatch) {
      const name = leaveMatch[1];
      onlinePlayers = onlinePlayers.filter(p => p.name !== name);
      broadcast({ type: 'players', data: onlinePlayers });
    }

    // Playit claim URL
    const playitMatch = line.match(/(https:\/\/playit\.gg\/claim\/[^\s]+)/);
    if (playitMatch) {
      const claimUrl = playitMatch[1];
      playitTunnels.pe = claimUrl;
      broadcast({ type: 'playit_claim', url: claimUrl });
    }
  };

  mcProcess.stdout.on('data', handleLine);
  mcProcess.stderr.on('data', handleLine);

  mcProcess.on('close', (code) => {
    serverStatus = 'offline';
    onlinePlayers = [];
    mcProcess = null;
    broadcast({ type: 'status', data: { status: 'offline' } });
    broadcast({ type: 'players', data: [] });
    broadcast({ type: 'log', data: `[MineYou] Server process exited with code ${code}` });
  });

  mcProcess.on('error', (err) => {
    serverStatus = 'offline';
    mcProcess = null;
    broadcast({ type: 'status', data: { status: 'offline' } });
    broadcast({ type: 'log', data: `[MineYou] Failed to start server: ${err.message}` });
  });
}

function stopMcServer() {
  if (mcProcess && mcProcess.stdin) {
    try { mcProcess.stdin.write('stop\n'); } catch (e) {}
  }
}

// ─── Static File Server ───────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function serveStatic(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      setCors(res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    setCors(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ─── Request Router ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveStatic(path.join(PUBLIC_DIR, 'index.html'), res);
    return;
  }

  // Serve other static assets from public/
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith(PUBLIC_DIR)) {
      sendError(res, 403, 'Forbidden');
      return;
    }
    serveStatic(normalized, res);
    return;
  }

  // ── API Routes ────────────────────────────────────────────────────────────

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const files = scanDir(SERVER_DIR, SERVER_DIR);
    sendJson(res, 200, {
      status: serverStatus,
      players: onlinePlayers,
      version: selectedVersion.version,
      ramMb: selectedVersion.ramMb,
      playitTunnels,
      files,
    });
    return;
  }

  // POST /api/resources/build
  if (method === 'POST' && pathname === '/api/resources/build') {
    const body = await parseBody(req);
    // Update selectedVersion from body
    if (body.version) selectedVersion.version = body.version;
    if (body.ramMb)   selectedVersion.ramMb   = body.ramMb;
    if (body.engine)  selectedVersion.engine  = body.engine;
    await handleBuild(body, res);
    return;
  }

  // GET /api/files/read?path=...
  if (method === 'GET' && pathname === '/api/files/read') {
    const relPath = url.searchParams.get('path') || '';
    const fullPath = path.resolve(SERVER_DIR, relPath);
    if (!fullPath.startsWith(SERVER_DIR)) {
      sendError(res, 403, 'Forbidden: path escapes server directory');
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      sendError(res, 404, 'File not found');
      return;
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      sendJson(res, 200, { ok: true, content });
    } catch (e) {
      sendError(res, 500, e.message);
    }
    return;
  }

  // POST /api/files/save
  if (method === 'POST' && pathname === '/api/files/save') {
    const body = await parseBody(req);
    const relPath = body.path || '';
    const content = body.content !== undefined ? body.content : '';
    const fullPath = path.resolve(SERVER_DIR, relPath);
    if (!fullPath.startsWith(SERVER_DIR)) {
      sendError(res, 403, 'Forbidden: path escapes server directory');
      return;
    }
    try {
      ensureDir(path.dirname(fullPath));
      fs.writeFileSync(fullPath, content, 'utf8');
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 500, e.message);
    }
    return;
  }

  // GET /api/files/scan
  if (method === 'GET' && pathname === '/api/files/scan') {
    const files = scanDir(SERVER_DIR, SERVER_DIR);
    sendJson(res, 200, { ok: true, files });
    return;
  }

  // POST /api/server/start
  if (method === 'POST' && pathname === '/api/server/start') {
    const body = await parseBody(req);
    const version = body.version || selectedVersion.version;
    const ramMb   = body.ramMb   || selectedVersion.ramMb;
    if (mcProcess) {
      sendError(res, 400, 'Server is already running');
      return;
    }
    startMcServer(version, ramMb);
    sendJson(res, 200, { ok: true, status: serverStatus });
    return;
  }

  // POST /api/server/stop
  if (method === 'POST' && pathname === '/api/server/stop') {
    if (!mcProcess) {
      sendError(res, 400, 'Server is not running');
      return;
    }
    stopMcServer();
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/server/restart
  if (method === 'POST' && pathname === '/api/server/restart') {
    const body = await parseBody(req);
    const version = body.version || selectedVersion.version;
    const ramMb   = body.ramMb   || selectedVersion.ramMb;

    const doStart = () => startMcServer(version, ramMb);

    if (mcProcess) {
      stopMcServer();
      // Wait for process to close then restart
      const onClose = () => {
        mcProcess = null;
        doStart();
      };
      if (mcProcess) {
        mcProcess.once('close', onClose);
      } else {
        doStart();
      }
    } else {
      doStart();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/server/command
  if (method === 'POST' && pathname === '/api/server/command') {
    const body = await parseBody(req);
    const command = (body.command || '').trim();
    if (!mcProcess || !mcProcess.stdin) {
      sendError(res, 400, 'Server is not running');
      return;
    }
    try {
      mcProcess.stdin.write(`${command}\n`);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 500, e.message);
    }
    return;
  }

  // GET /api/network/lan
  if (method === 'GET' && pathname === '/api/network/lan') {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push({ name, address: iface.address });
        }
      }
    }
    let primary = '127.0.0.1';
    // Ưu tiên Wi-Fi hoặc Ethernet thật, tránh vEthernet ảo của WSL/Hyper-V
    const realIface = ips.find(i => {
      const n = i.name.toLowerCase();
      return !n.includes('vethernet') && !n.includes('virtual') && !n.includes('wsl') && !n.includes('hyper-v');
    });
    if (realIface) {
      primary = realIface.address;
    } else if (ips.length > 0) {
      primary = ips[0].address;
    }
    sendJson(res, 200, { ok: true, interfaces: ips, ip: primary, primary });
    return;
  }

  // 404 fallback
  sendError(res, 404, `Route not found: ${method} ${pathname}`);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[MineYou] Unhandled error:', err);
    try { sendError(res, 500, 'Internal server error'); } catch (_) {}
  });
});

// ─── WebSocket Upgrade Handler ────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  clients.add(socket);

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => {
    clients.delete(socket);
    try { socket.destroy(); } catch (_) {}
  });

  // Send initial status on connect
  try {
    const initMsg = JSON.stringify({
      type: 'status',
      data: {
        status: serverStatus,
        players: onlinePlayers,
        playitTunnels,
      },
    });
    socket.write(encodeWsFrame(initMsg));
  } catch (_) {}
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  MineYou M3 — Bảng Điều Khiển Minecraft (Windows 11)  ║');
  console.log('║  Mở trình duyệt tại: http://localhost:3000             ║');
  console.log('╚════════════════════════════════════════════════════════╝');
});
