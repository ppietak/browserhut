# Device Dashboard

Web-based dashboard for running Android emulator and Linux (Chromium) side by side. Self-contained Makefile — downloads JDK and Android SDK on first run. No Homebrew needed.

## Features

- **Android emulator** — streamed live to browser canvas via gRPC, with full touch/keyboard input
- **Linux desktop** — Chromium in Docker, accessed via noVNC iframe
- **Scroll** — mouse wheel scrolls vertically on Android; Shift + wheel scrolls horizontally
- **Pinch zoom** — hold mouse button + scroll wheel to zoom in/out on Android
- **Keyboard mapping** — Mac shortcuts (Cmd+C/V/X/Z, Cmd+Arrow, Option+Arrow, etc.) translated to Android/Linux equivalents
- **Clipboard sync** — Cmd+C / Cmd+V syncs clipboard between Mac and Android/Linux
- **Multi-instance** — open dashboard in multiple browser windows to control Android and Linux simultaneously
- **Nav buttons** — on-screen Back, Home, Recents for Android
- **Reset Chrome** — one-click reset of Chrome state on Android
- **Auto-setup** — first run downloads JDK, Android SDK, system images, and creates AVD automatically

## Usage

```bash
make start   # start backend server + open dashboard (downloads everything on first run)
make stop    # shut down everything (emulator, Linux container, backend)
make open    # re-open the dashboard in browser
```

## Custom image

```bash
make start API=33 IMAGE=google_apis_playstore
```

Each combination gets its own AVD automatically (e.g. `emu-33-google_apis_playstore`).

| Variable | Default | Values |
|---|---|---|
| `API` | `34` | Android API level (30, 33, 34, 35…) |
| `IMAGE` | `google_apis` | `google_apis`, `google_apis_playstore`, `default` |
| `HEADLESS` | `0` | `1` = no window, no audio (CI) |

## Finding available values

After first `make start`, you can query the SDK directly:

```bash
# Available system images (Google APIs):
.android-sdk/cmdline-tools/latest/bin/sdkmanager --list | grep system-images | grep google

# Available device profiles:
.android-sdk/cmdline-tools/latest/bin/avdmanager list device -c
```

## How it works

Everything is stored locally in the project directory:

- `.jdk/` — Adoptium JDK 17
- `.android-sdk/` — Android SDK (cmdline-tools, platform-tools, emulator, system images)
- `.avd/` — AVD data
- `web/` — Node.js backend (gRPC bridge, WebSocket server, static files)

`make clean` removes AVDs only (quick re-setup). `make clean-all` removes everything.
