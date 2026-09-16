#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CLANG_MODULE_CACHE_PATH="$PWD/.local/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.local/swift-cache"
swift build --package-path macos --configuration release --disable-sandbox
APP="$PWD/.local/Dayflow Sync.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/.build/release/DayflowSync "$APP/Contents/MacOS/DayflowSync"
cp macos/Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
printf 'Built %s\n' "$APP"
