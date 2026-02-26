(function() {
  var API_BASE = 'http://' + location.host;
  var WS_URL = 'ws://' + location.host;

  var canvas = document.getElementById('screen');
  var ctx = canvas.getContext('2d');
  var emuStatusEl = document.getElementById('emu-status');

  var deviceWidth = 1080;
  var deviceHeight = 2400;
  var ws = null;
  var frameCount = 0;
  var fps = 0;
  var stopping = false;

  function goBack() {
    window.location.href = '/';
  }

  // ── Frame rendering via rAF ─────────────────────────────
  var pendingFrame = null;
  var decoding = false;

  function renderLoop() {
    requestAnimationFrame(renderLoop);
    if (!pendingFrame || decoding) return;
    var buf = pendingFrame;
    pendingFrame = null;
    decoding = true;
    var blob = new Blob([buf], { type: 'image/png' });
    createImageBitmap(blob).then(function(bmp) {
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      frameCount++;
      decoding = false;
    }).catch(function() { decoding = false; });
  }
  requestAnimationFrame(renderLoop);

  // FPS counter
  setInterval(function() {
    fps = frameCount;
    frameCount = 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      emuStatusEl.textContent = 'Connected | ' + fps + ' FPS';
    }
  }, 1000);

  function setCanvasSize() {
    var ratio = deviceWidth / deviceHeight;
    var maxH = window.innerHeight * 0.8;
    var maxW = window.innerWidth * 0.9;
    var h = maxH;
    var w = h * ratio;
    if (w > maxW) { w = maxW; h = w / ratio; }
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    canvas.width = 540;
    canvas.height = Math.round(540 / ratio);
  }

  // ── WebSocket connection ────────────────────────────────
  var wsReconnectDelay = 1000;

  function connectWs() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      emuStatusEl.textContent = 'Connected';
      emuStatusEl.className = 'device-status connected';
      wsReconnectDelay = 1000;
    };

    ws.onmessage = function(evt) {
      if (typeof evt.data === 'string') {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'clipboard') {
          if (msg.text) navigator.clipboard.writeText(msg.text).catch(function() {});
        } else if (msg.type === 'config') {
          deviceWidth = msg.deviceWidth;
          deviceHeight = msg.deviceHeight;
          setCanvasSize();
        } else if (msg.type === 'status') {
          if (msg.emulator === 'stopped') {
            stopping = true;
            if (ws) { ws.close(); ws = null; }
            goBack();
          }
        }
        return;
      }
      // Binary frame
      pendingFrame = evt.data;
    };

    ws.onclose = function() {
      emuStatusEl.textContent = 'Disconnected';
      emuStatusEl.className = 'device-status error';
      if (!stopping) {
        setTimeout(connectWs, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
      }
    };

    ws.onerror = function() { ws.close(); };
  }

  // ── Coordinate mapping ──────────────────────────────────
  function mapCoords(e) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * deviceWidth),
      y: Math.round(((e.clientY - rect.top) / rect.height) * deviceHeight),
    };
  }

  // ── Touch / Mouse input ─────────────────────────────────
  var mouseDown = false;
  var pinching = false;

  canvas.addEventListener('mousedown', function(e) {
    e.preventDefault();
    mouseDown = true;
    pinching = false;
    var c = mapCoords(e);
    send({ type: 'touch', x: c.x, y: c.y, pressure: 1024, id: 0 });
  });

  canvas.addEventListener('mousemove', function(e) {
    if (!mouseDown || pinching) return;
    e.preventDefault();
    var c = mapCoords(e);
    send({ type: 'touch', x: c.x, y: c.y, pressure: 1024, id: 0 });
  });

  canvas.addEventListener('mouseup', function(e) {
    e.preventDefault();
    if (pinching) { pinching = false; mouseDown = false; return; }
    mouseDown = false;
    var c = mapCoords(e);
    send({ type: 'touch', x: c.x, y: c.y, pressure: 0, id: 0 });
  });

  canvas.addEventListener('mouseleave', function() {
    if (mouseDown && !pinching) {
      mouseDown = false;
      send({ type: 'touch', x: 0, y: 0, pressure: 0, id: 0 });
    }
    if (pinching) { pinching = false; mouseDown = false; }
  });

  // ── Touch events (trackpad / touchscreen) ───────────────
  function mapTouch(t) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((t.clientX - rect.left) / rect.width) * deviceWidth),
      y: Math.round(((t.clientY - rect.top) / rect.height) * deviceHeight),
    };
  }

  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var c = mapTouch(t);
      send({ type: 'touch', x: c.x, y: c.y, pressure: 1024, id: t.identifier });
    }
  });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var c = mapTouch(t);
      send({ type: 'touch', x: c.x, y: c.y, pressure: 1024, id: t.identifier });
    }
  });

  canvas.addEventListener('touchend', function(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var c = mapTouch(t);
      send({ type: 'touch', x: c.x, y: c.y, pressure: 0, id: t.identifier });
    }
  });

  canvas.addEventListener('touchcancel', function(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      send({ type: 'touch', x: 0, y: 0, pressure: 0, id: e.changedTouches[i].identifier });
    }
  });

  canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

  // ── Scroll / Pinch-zoom via mouse wheel ────────────────
  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    var c = mapCoords(e);

    if (mouseDown && !pinching) {
      send({ type: 'touch', x: c.x, y: c.y, pressure: 0, id: 0 });
      pinching = true;
    }

    if (mouseDown) {
      send({ type: 'pinch', x: c.x, y: c.y, delta: e.deltaY > 0 ? 1 : -1 });
      return;
    }

    var dx = e.deltaX;
    var dy = e.deltaY;
    if (e.shiftKey) { dx = dy; dy = 0; }
    send({ type: 'scroll', x: c.x, y: c.y, dx: dx, dy: dy });
  }, { passive: false });

  // ── Keyboard input ──────────────────────────────────────
  var SPECIAL_KEYS = {
    ArrowLeft:1, ArrowRight:1, ArrowUp:1, ArrowDown:1,
    Backspace:1, Delete:1, Enter:1, Tab:1, Escape:1,
    Home:1, End:1, PageUp:1, PageDown:1,
    F1:1,F2:1,F3:1,F4:1,F5:1,F6:1,F7:1,F8:1,F9:1,F10:1,F11:1,F12:1,
  };
  var MODIFIER_KEYS = { Meta:1, Alt:1, Shift:1, Control:1, CapsLock:1 };

  document.addEventListener('keydown', function(e) {
    if (e.repeat) return;
    var k = e.key;
    var kl = k.toLowerCase();
    var cmd = e.metaKey;
    var opt = e.altKey;
    var shift = e.shiftKey;

    if (MODIFIER_KEYS[k]) return;

    if (cmd && kl === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then(function(text) {
        if (text) send({ type: 'paste', text: text });
        else send({ type: 'key', eventType: 'keydown', key: 'v', ctrl: true, shift: false, alt: false });
      }).catch(function() {
        send({ type: 'key', eventType: 'keydown', key: 'v', ctrl: true, shift: false, alt: false });
      });
      return;
    }

    if (cmd && kl === 'c') {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: 'c', ctrl: true, shift: false, alt: false });
      setTimeout(function() { send({ type: 'clipboard-read' }); }, 200);
      return;
    }

    if (cmd && kl.length === 1 && kl >= 'a' && kl <= 'z') {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: kl, ctrl: true, shift: shift, alt: false });
      return;
    }

    if (cmd && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: k === 'ArrowLeft' ? 'Home' : 'End', ctrl: false, shift: shift, alt: false });
      return;
    }

    if (cmd && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: k === 'ArrowUp' ? 'Home' : 'End', ctrl: true, shift: shift, alt: false });
      return;
    }

    if (opt && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: k, ctrl: true, shift: shift, alt: false });
      return;
    }

    if (opt && k === 'Backspace') {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: 'Backspace', ctrl: true, shift: false, alt: false });
      return;
    }

    if (opt && k === 'Delete') {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: 'Delete', ctrl: true, shift: false, alt: false });
      return;
    }

    if (cmd && k === 'Backspace') {
      e.preventDefault();
      send({ type: 'key', eventType: 'keydown', key: 'Home', ctrl: false, shift: true, alt: false });
      setTimeout(function() { send({ type: 'key', eventType: 'keydown', key: 'Backspace', ctrl: false, shift: false, alt: false }); }, 50);
      return;
    }

    if (cmd || e.ctrlKey) return;

    e.preventDefault();
    send({ type: 'key', eventType: 'keydown', key: k, ctrl: false, shift: shift, alt: opt });
  });

  document.addEventListener('keyup', function(e) {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
  });

  // ── Nav buttons ─────────────────────────────────────────
  document.querySelectorAll('.side-nav button[data-key]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      send({ type: 'key', eventType: 'keypress', key: btn.getAttribute('data-key') });
    });
  });

  document.getElementById('reset-chrome').addEventListener('click', function() {
    send({ type: 'reset-chrome' });
  });

  document.getElementById('stop-btn').addEventListener('click', function() {
    stopping = true;
    if (ws) { ws.close(); ws = null; }
    fetch(API_BASE + '/api/emulator/stop', { method: 'POST' })
      .then(goBack)
      .catch(function(err) { console.error('Stop failed:', err); });
  });

  // ── Send helper ─────────────────────────────────────────
  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // ── Init ────────────────────────────────────────────────
  setCanvasSize();
  window.addEventListener('resize', setCanvasSize);
  connectWs();
})();
