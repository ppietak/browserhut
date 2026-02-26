(function() {
  var API_BASE = 'http://localhost:3000';

  var startBtn = document.getElementById('start-btn');
  var stopEmuBtn = document.getElementById('stop-emu-btn');
  var linuxStartBtn = document.getElementById('linux-start-btn');
  var stopLinuxBtn = document.getElementById('stop-linux-btn');
  var backendStatusEl = document.getElementById('backend-status');
  var emuCardStatus = document.getElementById('emu-card-status');
  var linuxCardStatus = document.getElementById('linux-card-status');

  var backendConnected = false;
  var emulatorState = 'stopped';
  var linuxState = 'stopped';

  function updateUI() {
    if (!backendConnected) {
      emuCardStatus.textContent = 'Backend not connected';
      emuCardStatus.className = 'card-status error';
      startBtn.disabled = true;
      stopEmuBtn.style.display = 'none';
      linuxCardStatus.textContent = 'Backend not connected';
      linuxCardStatus.className = 'card-status error';
      linuxStartBtn.disabled = true;
      stopLinuxBtn.style.display = 'none';
      backendStatusEl.textContent = 'Disconnected';
      backendStatusEl.className = '';
      return;
    }

    backendStatusEl.textContent = 'Backend connected';
    backendStatusEl.className = 'connected';

    // Android card
    if (emulatorState === 'stopped') {
      emuCardStatus.textContent = 'Stopped';
      emuCardStatus.className = 'card-status';
      startBtn.textContent = 'Start';
      startBtn.disabled = false;
      stopEmuBtn.style.display = 'none';
    } else if (emulatorState === 'starting') {
      emuCardStatus.textContent = 'Starting...';
      emuCardStatus.className = 'card-status starting';
      startBtn.textContent = 'Starting...';
      startBtn.disabled = true;
      stopEmuBtn.style.display = 'none';
    } else if (emulatorState === 'running') {
      emuCardStatus.textContent = 'Running';
      emuCardStatus.className = 'card-status running';
      startBtn.textContent = 'Connect';
      startBtn.disabled = false;
      stopEmuBtn.style.display = '';
    }

    // Linux card
    if (linuxState === 'stopped') {
      linuxCardStatus.textContent = 'Stopped';
      linuxCardStatus.className = 'card-status';
      linuxStartBtn.textContent = 'Start';
      linuxStartBtn.disabled = false;
      stopLinuxBtn.style.display = 'none';
    } else if (linuxState === 'starting') {
      linuxCardStatus.textContent = 'Starting...';
      linuxCardStatus.className = 'card-status starting';
      linuxStartBtn.textContent = 'Starting...';
      linuxStartBtn.disabled = true;
      stopLinuxBtn.style.display = 'none';
    } else if (linuxState === 'stopping') {
      linuxCardStatus.textContent = 'Stopping...';
      linuxCardStatus.className = 'card-status starting';
      linuxStartBtn.textContent = 'Stopping...';
      linuxStartBtn.disabled = true;
      stopLinuxBtn.style.display = 'none';
    } else if (linuxState === 'running') {
      linuxCardStatus.textContent = 'Running';
      linuxCardStatus.className = 'card-status running';
      linuxStartBtn.textContent = 'Connect';
      linuxStartBtn.disabled = false;
      stopLinuxBtn.style.display = '';
    }
  }

  // ── Status polling (REST only) ──────────────────────────

  function pollStatus() {
    fetch(API_BASE + '/api/status')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        backendConnected = true;
        emulatorState = data.emulator;
        linuxState = data.linux;
        updateUI();
      })
      .catch(function() {
        backendConnected = false;
        updateUI();
      });
  }

  // ── Start / Connect buttons ─────────────────────────────

  startBtn.addEventListener('click', function() {
    if (emulatorState === 'running') {
      window.location.href = API_BASE + '/android';
      return;
    }
    if (emulatorState !== 'stopped') return;
    startBtn.disabled = true;
    fetch(API_BASE + '/api/emulator/start', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        emulatorState = data.emulator || 'starting';
        updateUI();
        waitAndRedirect('emulator', API_BASE + '/android');
      })
      .catch(function(err) {
        console.error('Start failed:', err);
        startBtn.disabled = false;
      });
  });

  linuxStartBtn.addEventListener('click', function() {
    if (linuxState === 'running') {
      window.location.href = API_BASE + '/linux';
      return;
    }
    if (linuxState !== 'stopped') return;
    linuxStartBtn.disabled = true;
    fetch(API_BASE + '/api/linux/start', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        linuxState = data.linux || 'starting';
        updateUI();
        waitAndRedirect('linux', API_BASE + '/linux');
      })
      .catch(function(err) {
        console.error('Linux start failed:', err);
        linuxStartBtn.disabled = false;
      });
  });

  function waitAndRedirect(device, url) {
    var check = setInterval(function() {
      fetch(API_BASE + '/api/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var state = device === 'emulator' ? data.emulator : data.linux;
          if (state === 'running') {
            clearInterval(check);
            window.location.href = url;
          } else if (state === 'stopped') {
            clearInterval(check);
            emulatorState = data.emulator;
            linuxState = data.linux;
            updateUI();
          } else {
            emulatorState = data.emulator;
            linuxState = data.linux;
            updateUI();
          }
        })
        .catch(function() {});
    }, 1000);
  }

  // ── Stop buttons ────────────────────────────────────────

  stopEmuBtn.addEventListener('click', function() {
    fetch(API_BASE + '/api/emulator/stop', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function() {
        emulatorState = 'stopped';
        updateUI();
      })
      .catch(function(err) { console.error('Stop failed:', err); });
  });

  stopLinuxBtn.addEventListener('click', function() {
    fetch(API_BASE + '/api/linux/stop', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function() {
        linuxState = 'stopping';
        updateUI();
      })
      .catch(function(err) { console.error('Linux stop failed:', err); });
  });

  // ── Init ────────────────────────────────────────────────

  pollStatus();
  setInterval(pollStatus, 2000);
})();
