const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { WebSocketServer } = require('ws');


const GRPC_PORT = process.env.GRPC_PORT || 8554;
const WEB_PORT = process.env.WEB_PORT || 3000;
const NOVNC_PORT = process.env.NOVNC_PORT || 7900;
const PROTO_PATH = path.join(__dirname, '..', '.android-sdk', 'emulator', 'lib', 'emulator_controller.proto');
const ADB_PATH = path.join(__dirname, '..', '.android-sdk', 'platform-tools', 'adb');
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

// ── Emulator state ────────────────────────────────────────

let emulatorState = 'stopped'; // stopped | starting | running
let emulatorProcess = null;

// ── ADB input (sendKey via gRPC is broken in emulator v36) ───

const W3C_TO_KEYCODE = {
  'GoBack': 4, 'GoHome': 3, 'AppSwitch': 187, 'Power': 26,
  'Enter': 66, 'Backspace': 67, 'Delete': 112, 'Tab': 61, 'Escape': 111,
  'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
  'Home': 122, 'End': 123, 'PageUp': 92, 'PageDown': 93,
  'AudioVolumeUp': 24, 'AudioVolumeDown': 25,
  'F1': 131, 'F2': 132, 'F3': 133, 'F4': 134, 'F5': 135,
  'F6': 136, 'F7': 137, 'F8': 138, 'F9': 139, 'F10': 140,
  'F11': 141, 'F12': 142,
};

const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta',
  'CapsLock', 'NumLock', 'ScrollLock',
]);

let adbShell = null;

function ensureAdbShell() {
  if (adbShell && !adbShell.killed) return adbShell;
  console.log('Spawning persistent adb shell...');
  adbShell = spawn(ADB_PATH, ['shell'], { stdio: ['pipe', 'ignore', 'pipe'] });
  adbShell.on('exit', (code) => {
    console.log('adb shell exited with code', code);
    adbShell = null;
  });
  adbShell.stderr.on('data', (d) => console.error('adb stderr:', d.toString().trim()));
  return adbShell;
}

function adbCmd(cmd) {
  const shell = ensureAdbShell();
  shell.stdin.write(cmd + ' &\n');
}

function charToKeycode(key) {
  const c = key.toLowerCase();
  if (c >= 'a' && c <= 'z') return c.charCodeAt(0) - 97 + 29; // KEYCODE_A=29
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48 + 7;  // KEYCODE_0=7
  return undefined;
}

function handleKey(eventType, key, ctrl, shift, alt) {
  if (eventType === 'keyup') return;
  if (MODIFIER_KEYS.has(key)) return;

  const keycode = W3C_TO_KEYCODE[key] || charToKeycode(key);

  // Any modifier present → use keycombination
  if ((ctrl || shift || alt) && keycode !== undefined) {
    const parts = [];
    if (ctrl) parts.push(113);  // KEYCODE_CTRL_LEFT
    if (shift) parts.push(59);  // KEYCODE_SHIFT_LEFT
    if (alt) parts.push(57);    // KEYCODE_ALT_LEFT
    parts.push(keycode);
    adbCmd(`input keycombination ${parts.join(' ')}`);
    return;
  }

  if (keycode !== undefined) {
    adbCmd(`input keyevent ${keycode}`);
  } else if (key.length === 1) {
    const escaped = key === "'" ? "'\\''" : "'" + key + "'";
    adbCmd(`input text ${escaped}`);
  }
}

// ── gRPC client setup (deferred) ─────────────────────────

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);
const EmulatorController = proto.android.emulation.control.EmulatorController;

let streamClient = null;
let inputClient = null;

function connectGrpc() {
  console.log('Connecting gRPC clients...');
  streamClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());
  inputClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());
}

// ── Device dimensions ──────────────────────────────────────

let deviceWidth = 1080;
let deviceHeight = 2400;
let streamWidth = 540;
let streamHeight = 1200;

function discoverDimensions() {
  return new Promise((resolve) => {
    streamClient.getScreenshot({ format: 'PNG', width: 0, height: 0 }, (err, image) => {
      if (err) {
        console.error('Failed to get initial screenshot, using defaults:', err.message);
        return resolve();
      }
      if (image && image.format) {
        deviceWidth = image.format.width || deviceWidth;
        deviceHeight = image.format.height || deviceHeight;
      }
      // width=0 (native) is fastest when device <= 540px; otherwise downscale
      streamWidth = deviceWidth <= 540 ? 0 : 540;
      console.log(`Device: ${deviceWidth}x${deviceHeight}, stream width: ${streamWidth || 'native'}`);
      resolve();
    });
  });
}

// ── Emulator lifecycle ─────────────────────────────────────

function startEmulator() {
  if (emulatorState !== 'stopped') return;
  emulatorState = 'starting';
  broadcastStatus();

  // Run make targets for AVD setup + emulator launch + boot wait + chrome setup
  const makeProc = spawn('make', ['-C', ROOT_DIR, 'launch-emulator'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  makeProc.stdout.on('data', (d) => {
    output += d.toString();
    process.stdout.write(d);
  });
  makeProc.stderr.on('data', (d) => {
    output += d.toString();
    process.stderr.write(d);
  });

  makeProc.on('exit', async (code) => {
    if (code !== 0) {
      console.error('Emulator launch failed with code', code);
      emulatorState = 'stopped';
      broadcastStatus();
      return;
    }

    // gRPC connect + discover dimensions
    connectGrpc();
    await discoverDimensions();
    ensureAdbShell();

    emulatorState = 'running';
    broadcastStatus();

    // Start streaming for all connected WS clients
    wss.clients.forEach((ws) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'config', deviceWidth, deviceHeight }));
        startStreamForClient(ws);
      }
    });
  });
}

function stopEmulator() {
  if (emulatorState === 'stopped') return;

  // Cancel all streams
  wss.clients.forEach((ws) => {
    if (ws._emuStream) {
      ws._emuStream.cancel();
      ws._emuStream = null;
    }
  });

  // Kill adb shell
  if (adbShell && !adbShell.killed) {
    adbShell.kill();
    adbShell = null;
  }

  // Close gRPC clients
  streamClient = null;
  inputClient = null;

  // Kill emulator via adb
  execFile(ADB_PATH, ['emu', 'kill'], (err) => {
    if (err) console.error('adb emu kill error:', err.message);
  });

  emulatorState = 'stopped';
  broadcastStatus();
}

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'status', emulator: emulatorState });
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ── Linux container lifecycle ──────────────────────────────

let linuxState = 'stopped'; // stopped | starting | running

function broadcastLinuxStatus() {
  const msg = JSON.stringify({ type: 'linux-status', linux: linuxState, novncPort: NOVNC_PORT });
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function startLinux() {
  if (linuxState !== 'stopped') return;
  linuxState = 'starting';
  broadcastLinuxStatus();

  const makeProc = spawn('make', ['-C', ROOT_DIR, 'launch-linux', `NOVNC_PORT=${NOVNC_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  makeProc.stdout.on('data', (d) => process.stdout.write(d));
  makeProc.stderr.on('data', (d) => process.stderr.write(d));

  makeProc.on('exit', (code) => {
    if (code !== 0) {
      console.error('Linux container launch failed with code', code);
      linuxState = 'stopped';
    } else {
      linuxState = 'running';
    }
    broadcastLinuxStatus();
  });
}

function stopLinux() {
  if (linuxState === 'stopped') return;
  linuxState = 'stopping';
  broadcastLinuxStatus();
  killLinuxShell();

  const makeProc = spawn('make', ['-C', ROOT_DIR, 'stop-linux'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  makeProc.stdout.on('data', (d) => process.stdout.write(d));
  makeProc.stderr.on('data', (d) => process.stderr.write(d));

  makeProc.on('exit', () => {
    linuxState = 'stopped';
    broadcastLinuxStatus();
  });
}

function resetLinux() {
  if (linuxState !== 'running') return;
  linuxState = 'starting';
  broadcastLinuxStatus();

  const makeProc = spawn('make', ['-C', ROOT_DIR, 'reset-linux', `NOVNC_PORT=${NOVNC_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  makeProc.stdout.on('data', (d) => process.stdout.write(d));
  makeProc.stderr.on('data', (d) => process.stderr.write(d));

  makeProc.on('exit', (code) => {
    linuxState = code === 0 ? 'running' : 'stopped';
    broadcastLinuxStatus();
  });
}

function checkLinuxRunning() {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--filter', 'name=webtest-linux-chrome', '--format', '{{.Names}}'], (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.trim() === 'webtest-linux-chrome');
    });
  });
}

// ── Linux input via persistent docker shell ─────────────────

const LINUX_CONTAINER = 'webtest-linux-chrome';

let linuxShell = null;

function ensureLinuxShell() {
  if (linuxShell && !linuxShell.killed) return linuxShell;
  console.log('Spawning persistent docker shell...');
  linuxShell = spawn('docker', ['exec', '-i', '-e', 'DISPLAY=:99.0', LINUX_CONTAINER, 'bash'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  linuxShell.on('exit', (code) => {
    console.log('docker shell exited with code', code);
    linuxShell = null;
  });
  linuxShell.stderr.on('data', (d) => console.error('docker stderr:', d.toString().trim()));
  return linuxShell;
}

function linuxCmd(cmd) {
  const shell = ensureLinuxShell();
  shell.stdin.write(cmd + ' &\n');
}

function killLinuxShell() {
  if (linuxShell && !linuxShell.killed) {
    linuxShell.kill();
    linuxShell = null;
  }
}

const JS_TO_XDOTOOL = {
  'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
  'Backspace': 'BackSpace', 'Enter': 'Return', 'Escape': 'Escape',
  'Tab': 'Tab', 'Delete': 'Delete', 'Home': 'Home', 'End': 'End',
  'PageUp': 'Prior', 'PageDown': 'Next',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
  'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
  'F11': 'F11', 'F12': 'F12',
};

function linuxKey(key, ctrl, shift, alt) {
  const xkey = JS_TO_XDOTOOL[key] || key;
  const mods = [];
  if (ctrl) mods.push('ctrl');
  if (shift) mods.push('shift');
  if (alt) mods.push('alt');
  mods.push(xkey);
  linuxCmd(`xdotool key ${mods.join('+')}`);
}

function linuxType(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  linuxCmd(`xdotool type --delay 0 -- '${escaped}'`);
}

function linuxPaste(text) {
  const escaped = text.replace(/'/g, "'\\''");
  linuxCmd(`echo -n '${escaped}' | xclip -selection clipboard && xdotool key ctrl+v`);
}

function readLinuxClipboard(callback) {
  execFile('docker', ['exec', '-e', 'DISPLAY=:99.0', LINUX_CONTAINER, 'xclip', '-selection', 'clipboard', '-o'],
    { timeout: 2000 }, (err, stdout) => {
      callback(err ? '' : stdout);
    });
}

// ── Static file server + REST API ──────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // REST API
  if (req.url === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { emulator: emulatorState, linux: linuxState, novncPort: NOVNC_PORT });
  }

  if (req.url === '/api/emulator/start' && req.method === 'POST') {
    if (emulatorState !== 'stopped') {
      return sendJson(res, 409, { error: 'Emulator is ' + emulatorState, emulator: emulatorState });
    }
    startEmulator();
    return sendJson(res, 200, { emulator: 'starting' });
  }

  if (req.url === '/api/emulator/stop' && req.method === 'POST') {
    if (emulatorState === 'stopped') {
      return sendJson(res, 200, { emulator: 'stopped' });
    }
    stopEmulator();
    return sendJson(res, 200, { emulator: 'stopped' });
  }

  if (req.url === '/api/linux/start' && req.method === 'POST') {
    if (linuxState !== 'stopped') {
      return sendJson(res, 409, { error: 'Linux is ' + linuxState, linux: linuxState });
    }
    startLinux();
    return sendJson(res, 200, { linux: 'starting' });
  }

  if (req.url === '/api/linux/stop' && req.method === 'POST') {
    if (linuxState === 'stopped') {
      return sendJson(res, 200, { linux: 'stopped' });
    }
    stopLinux();
    return sendJson(res, 200, { linux: 'stopping' });
  }

  if (req.url === '/api/linux/reset' && req.method === 'POST') {
    if (linuxState !== 'running') {
      return sendJson(res, 409, { error: 'Linux is not running', linux: linuxState });
    }
    resetLinux();
    return sendJson(res, 200, { linux: 'starting' });
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

// ── WebSocket server ───────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Send current status
  ws.send(JSON.stringify({ type: 'status', emulator: emulatorState }));
  ws.send(JSON.stringify({ type: 'linux-status', linux: linuxState, novncPort: NOVNC_PORT }));

  // If emulator is running, send config and start streaming
  if (emulatorState === 'running' && streamClient) {
    ws.send(JSON.stringify({ type: 'config', deviceWidth, deviceHeight }));
    startStreamForClient(ws);
  }

  // Input handler
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Linux input
    if (msg.type === 'linux-paste') {
      if (linuxState !== 'running') return;
      linuxPaste(msg.text);
      return;
    } else if (msg.type === 'linux-key') {
      if (linuxState !== 'running') return;
      linuxKey(msg.key, msg.ctrl, msg.shift, msg.alt);
      return;
    } else if (msg.type === 'linux-type') {
      if (linuxState !== 'running') return;
      linuxType(msg.text);
      return;
    } else if (msg.type === 'linux-clipboard-read') {
      if (linuxState !== 'running') return;
      readLinuxClipboard((text) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'linux-clipboard', text }));
        }
      });
      return;
    }

    // Only process emulator input when emulator is running
    if (emulatorState !== 'running' && msg.type !== 'reset-chrome') return;

    if (msg.type === 'reset-chrome') {
      adbCmd("pm clear com.android.chrome");
      setTimeout(() => {
        adbCmd("am start -a android.intent.action.VIEW -d about:blank -n com.android.chrome/com.google.android.apps.chrome.Main");
        setTimeout(() => adbCmd("input keyevent 4"), 3000);
      }, 500);
      return;
    } else if (msg.type === 'paste') {
      // Push Mac clipboard to Android, then Ctrl+V
      if (!inputClient) return;
      inputClient.setClipboard({ text: msg.text }, (err) => {
        if (err) console.error('setClipboard error:', err.message);
        else adbCmd('input keycombination 113 50'); // Ctrl+V
      });
    } else if (msg.type === 'clipboard-read') {
      if (!inputClient) return;
      inputClient.getClipboard({}, (err, clip) => {
        if (err) { console.error('getClipboard error:', err.message); return; }
        if (ws.readyState === 1 && clip && clip.text) {
          ws.send(JSON.stringify({ type: 'clipboard', text: clip.text }));
        }
      });
    } else if (msg.type === 'key') {
      handleKey(msg.eventType, msg.key, msg.ctrl, msg.shift, msg.alt);
    } else if (msg.type === 'touch') {
      if (!inputClient) return;
      inputClient.sendTouch({
        touches: [{
          x: msg.x,
          y: msg.y,
          pressure: msg.pressure,
          identifier: msg.id || 0,
        }],
      }, (err) => {
        if (err) console.error('sendTouch error:', err.message);
      });
    } else if (msg.type === 'scroll') {
      if (!inputClient) return;
      handleScroll(ws, msg.x, msg.y, msg.dx || 0, msg.dy || 0);
    } else if (msg.type === 'pinch') {
      if (!inputClient) return;
      handlePinch(ws, msg.x, msg.y, msg.delta);
    } else if (msg.type === 'mouse') {
      if (!inputClient) return;
      inputClient.sendMouse({
        x: msg.x,
        y: msg.y,
        buttons: msg.buttons,
      }, (err) => {
        if (err) console.error('sendMouse error:', err.message);
      });
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (ws._emuStream) ws._emuStream.cancel();
    clearTimeout(ws._scrollTimeout);
    clearTimeout(ws._pinchTimeout);
  });
});

// ── gRPC reconnection ──────────────────────────────────────

let reconnectTimer = null;
let reconnectDelay = 1000;

function scheduleStreamReconnect(ws) {
  if (ws.readyState !== 1) return;
  if (emulatorState !== 'running') return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (emulatorState !== 'running') return;
    console.log('Reconnecting gRPC clients...');
    connectGrpc();

    // Restart streams for all connected clients
    wss.clients.forEach((connectedWs) => {
      if (connectedWs.readyState === 1) {
        if (connectedWs._emuStream) {
          connectedWs._emuStream.cancel();
        }
        startStreamForClient(connectedWs);
      }
    });

    reconnectDelay = 1000;
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

// ── Scroll via gRPC touch (continuous drag gesture) ─────

function handleScroll(ws, x, y, dx, dy) {
  const SCROLL_ID = 3;
  const scale = 0.8;

  if (!ws._scrollState) {
    ws._scrollState = { cx: x, cy: y };
    inputClient.sendTouch({
      touches: [{ x, y, pressure: 1024, identifier: SCROLL_ID }],
    }, (err) => { if (err) console.error('scroll touch-down error:', err.message); });
  }

  ws._scrollState.cx -= Math.round(dx * scale);
  ws._scrollState.cy -= Math.round(dy * scale);
  ws._scrollState.cx = Math.max(0, Math.min(deviceWidth, ws._scrollState.cx));
  ws._scrollState.cy = Math.max(0, Math.min(deviceHeight, ws._scrollState.cy));

  inputClient.sendTouch({
    touches: [{ x: ws._scrollState.cx, y: ws._scrollState.cy, pressure: 1024, identifier: SCROLL_ID }],
  }, (err) => { if (err) console.error('scroll touch-move error:', err.message); });

  clearTimeout(ws._scrollTimeout);
  ws._scrollTimeout = setTimeout(() => {
    const s = ws._scrollState;
    if (!s) return;
    inputClient.sendTouch({
      touches: [{ x: s.cx, y: s.cy, pressure: 0, identifier: SCROLL_ID }],
    }, () => {});
    ws._scrollState = null;
  }, 150);
}

// ── Pinch-zoom via gRPC multi-touch ─────────────────────

function releasePinch(ws) {
  const ps = ws._pinchState;
  if (!ps) return;
  inputClient.sendTouch({
    touches: [
      { x: ps.cx, y: ps.cy - ps.spread, pressure: 0, identifier: 1 },
      { x: ps.cx, y: ps.cy + ps.spread, pressure: 0, identifier: 2 },
    ],
  }, (err) => { if (err) console.error('pinch release error:', err.message); });
  ws._pinchState = null;
}

function handlePinch(ws, cx, cy, delta) {
  if (!ws._pinchState) {
    const spread = 200;
    ws._pinchState = { cx, cy, spread, started: false, pending: true, queue: [] };

    const s = ws._pinchState;
    inputClient.sendTouch({
      touches: [
        { x: cx, y: cy - spread, pressure: 1024, identifier: 1 },
      ],
    }, (err) => {
      if (err) { console.error('pinch finger-A down error:', err.message); return; }
      inputClient.sendTouch({
        touches: [
          { x: cx, y: cy - spread, pressure: 1024, identifier: 1 },
          { x: cx, y: cy + spread, pressure: 1024, identifier: 2 },
        ],
      }, (err2) => {
        if (err2) { console.error('pinch finger-B down error:', err2.message); return; }
        s.started = true;
        // Flush queued moves
        for (const move of s.queue) move();
        s.queue = [];
        // If release was requested while we were setting up, do it now
        if (s.pending) releasePinch(ws);
      });
    });
  }

  const step = delta > 0 ? 40 : -40;
  ws._pinchState.spread = Math.max(40, ws._pinchState.spread + step);
  ws._pinchState.pending = false;

  const ps = ws._pinchState;
  const doMove = () => {
    inputClient.sendTouch({
      touches: [
        { x: ps.cx, y: ps.cy - ps.spread, pressure: 1024, identifier: 1 },
        { x: ps.cx, y: ps.cy + ps.spread, pressure: 1024, identifier: 2 },
      ],
    }, (err) => { if (err) console.error('pinch move error:', err.message); });
  };

  if (ws._pinchState.started) {
    doMove();
  } else {
    ws._pinchState.queue.push(doMove);
  }

  clearTimeout(ws._pinchTimeout);
  ws._pinchTimeout = setTimeout(() => {
    if (!ws._pinchState) return;
    if (!ws._pinchState.started) {
      // Setup not done yet — flag it so the setup callback releases
      ws._pinchState.pending = true;
      return;
    }
    releasePinch(ws);
  }, 300);
}

function startStreamForClient(ws) {
  if (!streamClient) return;
  let lastSendTime = 0;
  const MIN_FRAME_INTERVAL = 16; // ~60 FPS cap
  const stream = streamClient.streamScreenshot({ format: 'PNG', width: streamWidth });

  stream.on('data', (image) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 0) return;

    const now = Date.now();
    if (now - lastSendTime < MIN_FRAME_INTERVAL) return;

    ws.send(image.image);
    lastSendTime = now;
  });

  stream.on('error', (err) => {
    console.error('Screenshot stream error:', err.message);
    scheduleStreamReconnect(ws);
  });

  stream.on('end', () => {
    scheduleStreamReconnect(ws);
  });

  ws._emuStream = stream;
}

// ── Check if emulator is already running ───────────────────

function checkEmulatorRunning() {
  return new Promise((resolve) => {
    execFile(ADB_PATH, ['devices'], (err, stdout) => {
      if (err) return resolve(false);
      resolve(/emulator-/.test(stdout));
    });
  });
}

// ── Start ──────────────────────────────────────────────────

async function main() {
  // Check if emulator is already running (e.g. from previous session)
  if (await checkEmulatorRunning()) {
    console.log('Emulator already running, connecting...');
    connectGrpc();
    await discoverDimensions();
    ensureAdbShell();
    emulatorState = 'running';
  }

  // Check if Linux container is already running
  if (await checkLinuxRunning()) {
    console.log('Linux container already running');
    linuxState = 'running';
  }

  httpServer.listen(WEB_PORT, () => {
    console.log(`Backend server listening on http://localhost:${WEB_PORT}`);
    console.log(`Emulator state: ${emulatorState}`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
