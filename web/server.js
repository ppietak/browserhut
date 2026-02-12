const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { WebSocketServer } = require('ws');
const sharp = require('sharp');

const GRPC_PORT = process.env.GRPC_PORT || 8554;
const WEB_PORT = process.env.WEB_PORT || 3000;
const PROTO_PATH = path.join(__dirname, '..', '.android-sdk', 'emulator', 'lib', 'emulator_controller.proto');
const ADB_PATH = path.join(__dirname, '..', '.android-sdk', 'platform-tools', 'adb');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

// ── ADB input (sendKey via gRPC is broken in emulator v36) ───

const W3C_TO_KEYCODE = {
  'GoBack': 4, 'GoHome': 3, 'AppSwitch': 187, 'Power': 26,
  'Enter': 66, 'Backspace': 67, 'Delete': 112, 'Tab': 61, 'Escape': 111,
  'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
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

function handleKey(eventType, key, ctrl, shift) {
  // ADB input keyevent does full press-release, so only act on keydown/keypress
  if (eventType === 'keyup') return;
  if (MODIFIER_KEYS.has(key)) return;

  // Ctrl+key combos (Mac Cmd mapped to Ctrl by frontend)
  if (ctrl) {
    const kc = charToKeycode(key);
    if (kc !== undefined) {
      const parts = [113]; // KEYCODE_CTRL_LEFT
      if (shift) parts.push(59); // KEYCODE_SHIFT_LEFT
      parts.push(kc);
      adbCmd(`input keycombination ${parts.join(' ')}`);
      return;
    }
  }

  const keycode = W3C_TO_KEYCODE[key];
  if (keycode !== undefined) {
    adbCmd(`input keyevent ${keycode}`);
  } else if (key.length === 1) {
    // Printable character — e.key already accounts for Shift
    // Shell-escape with single quotes; handle literal single quote specially
    const escaped = key === "'" ? "'\\''" : "'" + key + "'";
    adbCmd(`input text ${escaped}`);
  }
}

// ── gRPC client setup ──────────────────────────────────────

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);
const EmulatorController = proto.android.emulation.control.EmulatorController;
// Separate connections: stream client for screenshots, input client for touch/mouse/clipboard.
// Prevents high-bandwidth screenshot stream from blocking low-latency input RPCs.
let streamClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());
let inputClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());

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

// ── Static file server ─────────────────────────────────────

const httpServer = http.createServer((req, res) => {
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
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket server ───────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  // Send config
  ws.send(JSON.stringify({ type: 'config', deviceWidth, deviceHeight }));

  // Start screenshot stream
  startStreamForClient(ws);

  // Input handler
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'reset-chrome') {
      adbCmd("pm clear com.android.chrome");
      setTimeout(() => {
        adbCmd("am start -a android.intent.action.VIEW -d about:blank -n com.android.chrome/com.google.android.apps.chrome.Main");
        setTimeout(() => adbCmd("input keyevent 4"), 3000);
      }, 500);
      return;
    } else if (msg.type === 'paste') {
      // Push Mac clipboard to Android, then Ctrl+V
      inputClient.setClipboard({ text: msg.text }, (err) => {
        if (err) console.error('setClipboard error:', err.message);
        else adbCmd('input keycombination 113 50'); // Ctrl+V
      });
    } else if (msg.type === 'key') {
      handleKey(msg.eventType, msg.key, msg.ctrl, msg.shift);
    } else if (msg.type === 'touch') {
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
    } else if (msg.type === 'mouse') {
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
  });
});

// ── gRPC reconnection ──────────────────────────────────────

let reconnectTimer = null;
let reconnectDelay = 1000;

function scheduleStreamReconnect(ws) {
  if (ws.readyState !== 1) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('Reconnecting gRPC clients...');
    streamClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());
    inputClient = new EmulatorController(`localhost:${GRPC_PORT}`, grpc.credentials.createInsecure());

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

function startStreamForClient(ws) {
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

// ── Start ──────────────────────────────────────────────────

async function main() {
  await discoverDimensions();
  ensureAdbShell(); // pre-warm persistent shell
  httpServer.listen(WEB_PORT, () => {
    console.log(`Web server listening on http://localhost:${WEB_PORT}`);
    console.log(`gRPC target: localhost:${GRPC_PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
