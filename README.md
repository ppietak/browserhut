# Browserhut

[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> A simple, self-hosted alternative to BrowserStack.
> Run an Android emulator and a Linux Chromium desktop in your browser — no cloud, no subscriptions, everything on your machine.

<p align="center">
  <img src="web/public/screenshot-dashboard.png" height="240" alt="Dashboard">
  &nbsp;&nbsp;
  <img src="web/public/screenshot-android.png" height="240" alt="Android emulator">
</p>

## Quick start

```bash
git clone git@github.com:ppietak/browserhut.git
cd browserhut
make start
```

This will:
1. Download Bun, JDK 17, and Android SDK (~20 GB on first run)
2. Start the backend server
3. Open the dashboard in your browser

From the dashboard, click **Start** on Android or Linux (or both).

```bash
make stop      # shut down everything
make open      # re-open the dashboard
```

## What it does

**Android emulator** — screen is streamed to a browser canvas via gRPC. Touch, keyboard, scroll, and pinch-zoom all work through the browser.

**Linux desktop** — runs Chromium in a Docker container, displayed via noVNC. Keyboard input is captured and forwarded.

Both can run simultaneously.

## Controls

| Input | Action |
|---|---|
| Click / drag | Touch |
| Scroll wheel | Vertical scroll |
| `Shift` + scroll | Horizontal scroll |
| Hold mouse button + scroll | Pinch zoom in/out |
| `Cmd+C` / `Cmd+V` | Clipboard sync with Mac |
| `Cmd+Arrow`, `Option+Arrow` | Mapped to Home/End, word nav |
| Side buttons | Back, Home, Recents (Android) |

## Requirements

- **macOS** (tested on Apple Silicon)
- **Docker**
- ~20 GB disk on first run (JDK, SDK, system image, AVD)

> **Note:** No manual dependencies — Bun, JDK, and Android SDK are all downloaded automatically by `make start`.

## Configuration

```bash
make start API=33 IMAGE=google_apis_playstore
```

| Variable | Default | Description |
|---|---|---|
| `API` | `34` | Android API level |
| `IMAGE` | `google_apis` | System image (`google_apis`, `google_apis_playstore`, `default`) |
| `HEADLESS` | `0` | Set to `1` for no-window mode (CI) |
| `WEB_PORT` | `3000` | Backend server port |
| `GRPC_PORT` | `8554` | Emulator gRPC port |
| `NOVNC_PORT` | `7900` | Linux noVNC port |

Each API/image combination gets its own AVD (e.g. `emu-33-google_apis_playstore`).

## Project structure

```
Makefile              # Downloads SDK, manages emulator and Linux container
Dockerfile.linux      # Chromium + xdotool + xclip on Selenium base image
web/
  server.js           # Backend: gRPC bridge, WebSocket, REST API (runs on Bun)
  public/
    index.html        # Dashboard
    android.html      # Android emulator view
    linux.html        # Linux desktop view
    styles.css        # Shared styles
    dashboard.js      # Dashboard logic (REST polling)
    android.js        # Emulator logic (WebSocket, canvas, input)
    linux.js          # Linux logic (WebSocket, noVNC, keyboard)
```

Everything downloaded at runtime lives in gitignored directories:

```
.bun/                 # Bun runtime (auto-downloaded)
.jdk/                 # Adoptium JDK 17
.android-sdk/         # Android SDK, emulator, system images
.avd/                 # AVD data
```

## Cleanup

```bash
make clean            # delete AVDs (keep SDK/JDK)
make clean-all        # delete everything (.bun, .jdk, .android-sdk, .avd)
```

## License

[MIT](LICENSE)
