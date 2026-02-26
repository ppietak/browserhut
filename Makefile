SHELL := /bin/bash

GRPC_PORT       ?= 8554
WEB_PORT        ?= 3000
NOVNC_PORT      ?= 7900
LINUX_CONTAINER ?= webtest-linux-chrome
API             ?= 34
IMAGE            ?= google_apis
JDK_MAJOR             ?= 17
CMDLINE_TOOLS_VERSION ?= 11076708
HEADLESS              ?= 0
BUN_VERSION           ?= 1.2

ROOT    := $(CURDIR)
SDK_DIR := $(ROOT)/.android-sdk
JDK_DIR := $(ROOT)/.jdk
AVD_DIR := $(ROOT)/.avd
BUN_DIR := $(ROOT)/.bun

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
  ABI           := arm64-v8a
  JDK_ARCH      := aarch64
  BUN_ARCH      := aarch64
  CHROME_BASE   := seleniarm/standalone-chromium:latest
else
  ABI           := x86_64
  JDK_ARCH      := x64
  BUN_ARCH      := x64
  CHROME_BASE   := selenium/standalone-chrome:latest
endif

CHROME_IMAGE    := webtest-linux-chrome:latest
LINUX_IMAGE_OK  := $(ROOT)/.linux-image.ok

AVD_NAME     := emu-$(API)-$(IMAGE)
SYSTEM_IMAGE := system-images;android-$(API);$(IMAGE);$(ABI)
SDKMANAGER   := $(SDK_DIR)/cmdline-tools/latest/bin/sdkmanager
AVDMANAGER   := $(SDK_DIR)/cmdline-tools/latest/bin/avdmanager
EMULATOR     := $(SDK_DIR)/emulator/emulator
ADB          := $(SDK_DIR)/platform-tools/adb

export JAVA_HOME        := $(JDK_DIR)/Contents/Home
export ANDROID_HOME     := $(SDK_DIR)
export ANDROID_SDK_ROOT := $(SDK_DIR)
export ANDROID_AVD_HOME := $(AVD_DIR)
export PATH             := $(BUN_DIR)/bin:$(JAVA_HOME)/bin:$(SDK_DIR)/cmdline-tools/latest/bin:$(SDK_DIR)/platform-tools:$(SDK_DIR)/emulator:$(PATH)

ifeq ($(HEADLESS),1)
  EMU_FLAGS := -no-window -no-audio -gpu swiftshader_indirect
else
  EMU_FLAGS := -no-window -no-audio -gpu host
endif

BUN_OK   := $(BUN_DIR)/.ok
JDK_OK   := $(JDK_DIR)/.ok
SDK_OK   := $(SDK_DIR)/.ok
IMAGE_OK := $(SDK_DIR)/.image-$(API)-$(IMAGE)-$(ABI).ok
AVD_OK   := $(AVD_DIR)/.avd-$(AVD_NAME).ok

# ── Bun ────────────────────────────────────────────────────
$(BUN_OK):
	@echo "▶ Downloading Bun $(BUN_VERSION)…"
	@mkdir -p "$(BUN_DIR)"
	@curl -fSL --progress-bar \
		"https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-$(BUN_ARCH).zip" \
		-o /tmp/_emu_bun.zip
	@unzip -oq /tmp/_emu_bun.zip -d /tmp/_emu_bun_unpack
	@mkdir -p "$(BUN_DIR)/bin"
	@mv /tmp/_emu_bun_unpack/bun-darwin-$(BUN_ARCH)/bun "$(BUN_DIR)/bin/bun"
	@chmod +x "$(BUN_DIR)/bin/bun"
	@rm -rf /tmp/_emu_bun.zip /tmp/_emu_bun_unpack
	@touch "$@"

# ── JDK ────────────────────────────────────────────────────
$(JDK_OK):
	@echo "▶ Downloading JDK $(JDK_MAJOR)…"
	@mkdir -p "$(JDK_DIR)"
	@curl -fSL --progress-bar \
		"https://api.adoptium.net/v3/binary/latest/$(JDK_MAJOR)/ga/mac/$(JDK_ARCH)/jdk/hotspot/normal/eclipse" \
		-o /tmp/_emu_jdk.tar.gz
	@tar xzf /tmp/_emu_jdk.tar.gz -C "$(JDK_DIR)" --strip-components=1
	@rm -f /tmp/_emu_jdk.tar.gz
	@touch "$@"

# ── SDK command-line tools + emulator ──────────────────────
$(SDK_OK): $(JDK_OK)
	@echo "▶ Downloading Android SDK tools…"
	@mkdir -p "$(SDK_DIR)"
	@curl -fSL --progress-bar \
		"https://dl.google.com/android/repository/commandlinetools-mac-$(CMDLINE_TOOLS_VERSION)_latest.zip" \
		-o /tmp/_emu_cmdtools.zip
	@rm -rf /tmp/_emu_cmdtools_unpack
	@unzip -q /tmp/_emu_cmdtools.zip -d /tmp/_emu_cmdtools_unpack
	@mkdir -p "$(SDK_DIR)/cmdline-tools"
	@rm -rf "$(SDK_DIR)/cmdline-tools/latest"
	@mv /tmp/_emu_cmdtools_unpack/cmdline-tools "$(SDK_DIR)/cmdline-tools/latest"
	@rm -rf /tmp/_emu_cmdtools_unpack /tmp/_emu_cmdtools.zip
	@yes 2>/dev/null | "$(SDKMANAGER)" --licenses > /dev/null 2>&1 || true
	@"$(SDKMANAGER)" "platform-tools" "emulator"
	@touch "$@"

# ── System image ───────────────────────────────────────────
$(IMAGE_OK): $(SDK_OK)
	@echo "▶ Installing $(SYSTEM_IMAGE)…"
	@"$(SDKMANAGER)" "$(SYSTEM_IMAGE)" "platforms;android-$(API)"
	@touch "$@"

# ── AVD ────────────────────────────────────────────────────
$(AVD_OK): $(IMAGE_OK)
	@echo "▶ Creating AVD \"$(AVD_NAME)\"…"
	@mkdir -p "$(AVD_DIR)"
	@echo no | "$(AVDMANAGER)" create avd \
		--name "$(AVD_NAME)" \
		--package "$(SYSTEM_IMAGE)" \
		--force
	@touch "$@"

# ── Public targets ─────────────────────────────────────────
.PHONY: start stop open clean clean-all setup-chrome launch-emulator build-linux launch-linux stop-linux reset-linux

start: $(BUN_OK) $(AVD_OK) $(LINUX_IMAGE_OK)
	@cd "$(ROOT)/web" && bun install --silent
	@echo "▶ Starting backend server on port $(WEB_PORT)…"
	@cd "$(ROOT)/web" && GRPC_PORT=$(GRPC_PORT) WEB_PORT=$(WEB_PORT) NOVNC_PORT=$(NOVNC_PORT) bun run server.js > "$(ROOT)/.web.log" 2>&1 &
	@sleep 1
	@echo "✔ Backend running at http://localhost:$(WEB_PORT)"
	@open "$(ROOT)/web/public/index.html"

stop:
	@-pkill -f "bun run server.js" 2>/dev/null || echo "(no backend running)"
	@"$(ADB)" emu kill 2>/dev/null || echo "(no emulator running)"
	@docker stop "$(LINUX_CONTAINER)" > /dev/null 2>&1 || true
	@echo "✔ Stopped."

open:
	@open "$(ROOT)/web/public/index.html"

launch-emulator: $(AVD_OK)
	@if "$(ADB)" devices 2>/dev/null | grep -q "emulator-"; then \
		echo "⚠ Emulator already running"; exit 0; \
	fi
	@echo "▶ Starting emulator…"
	@"$(EMULATOR)" -avd "$(AVD_NAME)" $(EMU_FLAGS) -grpc $(GRPC_PORT) > "$(ROOT)/.emulator.log" 2>&1 &
	@"$(ADB)" wait-for-device
	@echo "  Waiting for boot…"
	@"$(ADB)" shell 'while [ "$$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done' 2>/dev/null
	@echo "✔ Emulator ready."
	@$(MAKE) setup-chrome

setup-chrome:
	@echo "▶ Setting up Chrome…"
	@"$(ADB)" shell "echo 'chrome --disable-fre --no-default-browser-check --no-first-run --disable-notifications' > /data/local/tmp/chrome-command-line" 2>/dev/null
	@"$(ADB)" shell pm clear com.android.chrome > /dev/null 2>&1 || true
	@"$(ADB)" shell am start -a android.intent.action.VIEW -d "about:blank" -n com.android.chrome/com.google.android.apps.chrome.Main > /dev/null 2>&1
	@sleep 3
	@"$(ADB)" shell input keyevent 4
	@echo "✔ Chrome launched."

$(LINUX_IMAGE_OK):
	@echo "▶ Building Linux Chromium image…"
	@docker build -q -t "$(CHROME_IMAGE)" --build-arg BASE_IMAGE="$(CHROME_BASE)" -f "$(ROOT)/Dockerfile.linux" "$(ROOT)"
	@touch "$@"

launch-linux: $(LINUX_IMAGE_OK)
	@if docker ps --format '{{.Names}}' | grep -q "^$(LINUX_CONTAINER)$$"; then \
		echo "⚠ Linux container already running"; exit 0; \
	fi
	@docker rm -f "$(LINUX_CONTAINER)" > /dev/null 2>&1 || true
	@echo "▶ Starting Linux Chromium container…"
	@docker run -d --rm \
		--name "$(LINUX_CONTAINER)" \
		--shm-size=2g \
		-p $(NOVNC_PORT):7900 \
		-e SE_VNC_NO_PASSWORD=1 \
		-e SE_SCREEN_WIDTH=1280 \
		-e SE_SCREEN_HEIGHT=900 \
		-e SE_NODE_MAX_SESSIONS=1 \
		"$(CHROME_IMAGE)" > /dev/null
	@echo "  Waiting for VNC…"
	@for i in $$(seq 1 30); do \
		if curl -sf http://localhost:$(NOVNC_PORT) > /dev/null 2>&1; then break; fi; \
		sleep 1; \
	done
	@sleep 3
	@echo "  Launching Chromium…"
	@docker exec -d "$(LINUX_CONTAINER)" \
		chromium --no-first-run --disable-fre --no-default-browser-check \
		--disable-notifications --start-maximized about:blank
	@echo "✔ Linux Chromium ready at http://localhost:$(NOVNC_PORT)"

stop-linux:
	@docker rm -f "$(LINUX_CONTAINER)" > /dev/null 2>&1 || echo "(no container running)"
	@echo "✔ Linux container stopped."

reset-linux:
	@echo "▶ Restarting Linux container…"
	@docker stop "$(LINUX_CONTAINER)" > /dev/null 2>&1 || true
	@sleep 1
	@$(MAKE) launch-linux

clean:
	@rm -rf "$(AVD_DIR)" "$(SDK_DIR)"/.image-*.ok
	@echo "✔ AVDs cleaned."

clean-all:
	@rm -rf "$(SDK_DIR)" "$(JDK_DIR)" "$(AVD_DIR)" "$(BUN_DIR)" "$(ROOT)/.emulator.log" "$(ROOT)/.web.log"
	@echo "✔ All cleaned."
