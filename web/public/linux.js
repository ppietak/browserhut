(function() {
  var API_BASE = 'http://' + location.host;
  var WS_URL = 'ws://' + location.host;

  var linuxFrame = document.getElementById('linux-frame');
  var linuxStatusEl = document.getElementById('linux-status');
  var ws = null;
  var novncPort = 7900;
  var stopping = false;

  function goBack() {
    window.location.href = '/';
  }

  // ── Load noVNC iframe ───────────────────────────────────
  function loadNoVNC() {
    var novncUrl = 'http://localhost:' + novncPort + '/vnc_lite.html?scale=true';
    linuxStatusEl.textContent = 'Connected';
    linuxStatusEl.className = 'device-status connected';
    linuxFrame.src = 'about:blank';
    setTimeout(function() { linuxFrame.src = novncUrl; }, 300);
  }

  // ── WebSocket connection ────────────────────────────────
  var wsReconnectDelay = 1000;

  function connectWs() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      wsReconnectDelay = 1000;
    };

    ws.onmessage = function(evt) {
      if (typeof evt.data !== 'string') return;
      var msg = JSON.parse(evt.data);

      if (msg.type === 'linux-clipboard') {
        if (msg.text) navigator.clipboard.writeText(msg.text).catch(function() {});
      } else if (msg.type === 'linux-status') {
        if (msg.novncPort) novncPort = msg.novncPort;
        if (msg.linux === 'running') {
          loadNoVNC();
        } else if (msg.linux === 'stopped' || msg.linux === 'stopping') {
          stopping = true;
          if (ws) { ws.close(); ws = null; }
          goBack();
        }
      }
    };

    ws.onclose = function() {
      linuxStatusEl.textContent = 'Disconnected';
      linuxStatusEl.className = 'device-status error';
      if (!stopping) {
        setTimeout(connectWs, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
      }
    };

    ws.onerror = function() { ws.close(); };
  }

  // ── Keyboard capture (Mac → Linux mapping) ─────────────
  var SPECIAL_KEYS = {
    ArrowLeft:1, ArrowRight:1, ArrowUp:1, ArrowDown:1,
    Backspace:1, Delete:1, Enter:1, Tab:1, Escape:1,
    Home:1, End:1, PageUp:1, PageDown:1,
    F1:1,F2:1,F3:1,F4:1,F5:1,F6:1,F7:1,F8:1,F9:1,F10:1,F11:1,F12:1,
  };
  var MODIFIER_KEYS = { Meta:1, Alt:1, Shift:1, Control:1, CapsLock:1 };

  // Focus guard: steal focus back from iframe
  setInterval(function() {
    if (document.activeElement === linuxFrame || !document.hasFocus()) {
      window.focus();
    }
  }, 50);

  document.addEventListener('keydown', function(e) {
    var k = e.key;
    var kl = k.toLowerCase();
    var cmd = e.metaKey;
    var opt = e.altKey;
    var shift = e.shiftKey;

    if (MODIFIER_KEYS[k]) return;
    e.preventDefault();

    if (cmd && kl === 'v') {
      navigator.clipboard.readText().then(function(text) {
        if (text) send({ type: 'linux-paste', text: text });
        else send({ type: 'linux-key', key: 'v', ctrl: true, shift: false, alt: false });
      }).catch(function() {
        send({ type: 'linux-key', key: 'v', ctrl: true, shift: false, alt: false });
      });
      return;
    }

    if (cmd && kl === 'c') {
      send({ type: 'linux-key', key: 'c', ctrl: true, shift: false, alt: false });
      setTimeout(function() { send({ type: 'linux-clipboard-read' }); }, 200);
      return;
    }

    if (cmd && kl.length === 1 && kl >= 'a' && kl <= 'z') {
      send({ type: 'linux-key', key: kl, ctrl: true, shift: shift, alt: false });
      return;
    }

    if (cmd && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      send({ type: 'linux-key', key: k === 'ArrowLeft' ? 'Home' : 'End', ctrl: false, shift: shift, alt: false });
      return;
    }

    if (cmd && (k === 'ArrowUp' || k === 'ArrowDown')) {
      send({ type: 'linux-key', key: k === 'ArrowUp' ? 'Home' : 'End', ctrl: true, shift: shift, alt: false });
      return;
    }

    if (opt && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      send({ type: 'linux-key', key: k, ctrl: true, shift: shift, alt: false });
      return;
    }

    if (opt && (k === 'ArrowUp' || k === 'ArrowDown')) {
      for (var i = 0; i < 5; i++) send({ type: 'linux-key', key: k, ctrl: false, shift: shift, alt: false });
      return;
    }

    if (opt && k === 'Backspace') {
      send({ type: 'linux-key', key: 'BackSpace', ctrl: true, shift: false, alt: false });
      return;
    }

    if (opt && k === 'Delete') {
      send({ type: 'linux-key', key: 'Delete', ctrl: true, shift: false, alt: false });
      return;
    }

    if (cmd && k === 'Backspace') {
      send({ type: 'linux-key', key: 'Home', ctrl: false, shift: true, alt: false });
      setTimeout(function() { send({ type: 'linux-key', key: 'BackSpace', ctrl: false, shift: false, alt: false }); }, 50);
      return;
    }

    if (SPECIAL_KEYS[k]) {
      send({ type: 'linux-key', key: k, ctrl: false, shift: shift, alt: opt });
      return;
    }

    if (k.length === 1) {
      send({ type: 'linux-type', text: k });
      return;
    }
  });

  // ── Nav buttons ─────────────────────────────────────────
  document.getElementById('linux-reset-btn').addEventListener('click', function() {
    linuxFrame.src = 'about:blank';
    linuxStatusEl.textContent = 'Restarting...';
    linuxStatusEl.className = 'device-status';
    fetch(API_BASE + '/api/linux/reset', { method: 'POST' }).catch(function(err) {
      console.error('Linux reset failed:', err);
    });
  });

  document.getElementById('linux-stop-btn').addEventListener('click', function() {
    stopping = true;
    if (ws) { ws.close(); ws = null; }
    fetch(API_BASE + '/api/linux/stop', { method: 'POST' })
      .then(goBack)
      .catch(function(err) { console.error('Linux stop failed:', err); });
  });

  // ── Send helper ─────────────────────────────────────────
  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // ── Init ────────────────────────────────────────────────
  fetch(API_BASE + '/api/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.novncPort) novncPort = data.novncPort;
      if (data.linux === 'running') {
        loadNoVNC();
      } else if (data.linux === 'stopped') {
        stopping = true;
        goBack();
        return;
      }
      connectWs();
    })
    .catch(function() {
      linuxStatusEl.textContent = 'Backend not connected';
      linuxStatusEl.className = 'device-status error';
      connectWs();
    });
})();
