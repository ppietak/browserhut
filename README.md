# Android Emulator

Self-contained Makefile — downloads JDK and Android SDK on first run. No Homebrew needed.

## Usage

```bash
make start   # first run downloads everything automatically
make stop    # shut down
make clean       # delete AVDs (keep SDK/JDK)
make clean-all   # delete everything (.jdk, .android-sdk, .avd)
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

`make clean` removes AVDs only (quick re-setup). `make clean-all` removes everything.
