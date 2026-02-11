SHELL := /bin/bash

GRPC_PORT       ?= 8554
WEB_PORT        ?= 3000
API             ?= 34
IMAGE            ?= google_apis
JDK_MAJOR             ?= 17
CMDLINE_TOOLS_VERSION ?= 11076708
HEADLESS              ?= 0

ROOT    := $(CURDIR)
SDK_DIR := $(ROOT)/.android-sdk
JDK_DIR := $(ROOT)/.jdk
AVD_DIR := $(ROOT)/.avd

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
  ABI      := arm64-v8a
  JDK_ARCH := aarch64
else
  ABI      := x86_64
  JDK_ARCH := x64
endif

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
export PATH             := $(JAVA_HOME)/bin:$(SDK_DIR)/cmdline-tools/latest/bin:$(SDK_DIR)/platform-tools:$(SDK_DIR)/emulator:$(PATH)

ifeq ($(HEADLESS),1)
  EMU_FLAGS := -no-window -no-audio -gpu swiftshader_indirect
else
  EMU_FLAGS := -no-window -no-audio -gpu host
endif

JDK_OK   := $(JDK_DIR)/.ok
SDK_OK   := $(SDK_DIR)/.ok
IMAGE_OK := $(SDK_DIR)/.image-$(API)-$(IMAGE)-$(ABI).ok
AVD_OK   := $(AVD_DIR)/.avd-$(AVD_NAME).ok

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
.PHONY: start stop clean clean-all web-start web-stop

start: $(AVD_OK)
	@if "$(ADB)" devices 2>/dev/null | grep -q "emulator-"; then \
		echo "⚠ Emulator already running"; exit 0; \
	fi
	@echo "▶ Starting emulator…"
	@"$(EMULATOR)" -avd "$(AVD_NAME)" $(EMU_FLAGS) -grpc $(GRPC_PORT) > "$(ROOT)/.emulator.log" 2>&1 &
	@"$(ADB)" wait-for-device
	@echo "  Waiting for boot…"
	@"$(ADB)" shell 'while [ "$$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done' 2>/dev/null
	@echo "✔ Emulator ready."
	@$(MAKE) web-start

stop:
	@$(MAKE) web-stop
	@"$(ADB)" emu kill 2>/dev/null || echo "(no emulator running)"

clean:
	@rm -rf "$(AVD_DIR)" "$(SDK_DIR)"/.image-*.ok
	@echo "✔ AVDs cleaned."

web-start:
	@cd "$(ROOT)/web" && npm install --silent
	@echo "▶ Starting web server on port $(WEB_PORT)…"
	@cd "$(ROOT)/web" && GRPC_PORT=$(GRPC_PORT) WEB_PORT=$(WEB_PORT) node server.js > "$(ROOT)/.web.log" 2>&1 &
	@sleep 1
	@echo "✔ Web server running at http://localhost:$(WEB_PORT)"

web-stop:
	@-pkill -f "node server.js" 2>/dev/null || echo "(no web server running)"
	@echo "✔ Web server stopped."

clean-all:
	@rm -rf "$(SDK_DIR)" "$(JDK_DIR)" "$(AVD_DIR)" "$(ROOT)/.emulator.log" "$(ROOT)/.web.log"
	@echo "✔ All cleaned."
