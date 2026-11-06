#!/bin/sh
# Build the macOS selection assistant as an app bundle.
#
#   sh scripts/build-macos-helper.sh             # native architecture
#   sh scripts/build-macos-helper.sh --universal # arm64 + x86_64 (release use)
#
# Output: helper/macos/bin/SelectionAssistant.app
#
# The bundle matters for permissions: macOS attributes an Accessibility grant to
# the "responsible process", which is the app bundle LaunchServices launches.
# The host therefore starts this .app with `open`, not by spawning the inner
# binary directly. Ad-hoc signatures change on every rebuild, so System Settings
# may ask for Accessibility again after a rebuild.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sources="$here/helper/macos/Sources"
out_dir="$here/helper/macos/bin"
app="$out_dir/SelectionAssistant.app"
contents="$app/Contents"
out="$contents/MacOS/SelectionAssistant"

if [ ! -d "$sources" ]; then
  echo "error: macOS helper sources not found: $sources" >&2
  exit 1
fi
if [ ! -f "$sources/main.swift" ]; then
  echo "error: $sources/main.swift is missing" >&2
  exit 1
fi

swiftc=""
if command -v xcrun >/dev/null 2>&1; then
  if swiftc_path=$(xcrun --find swiftc 2>/dev/null); then
    swiftc="$swiftc_path"
  fi
fi
if [ -z "$swiftc" ] && command -v swiftc >/dev/null 2>&1; then
  swiftc=$(command -v swiftc)
fi
if [ -z "$swiftc" ]; then
  echo "error: swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

# Calling the absolute swiftc path without xcrun leaves SDKROOT unset; swiftc
# then fails with "unable to load standard library for target ...". Export the
# SDK explicitly so both invocation styles work.
if command -v xcrun >/dev/null 2>&1; then
  sdk_root=$(xcrun --show-sdk-path 2>/dev/null || true)
  if [ -n "$sdk_root" ]; then
    export SDKROOT="$sdk_root"
  fi
fi

arch=$(uname -m)
case "$arch" in
  arm64) native_target="arm64-apple-macosx13.1" ;;
  x86_64) native_target="x86_64-apple-macosx13.1" ;;
  *)
    echo "error: unsupported CPU architecture: $arch" >&2
    exit 1
    ;;
esac

# The agent shell runs under a sandbox that denies the default module cache in
# /var/folders. Keep the Swift and Clang caches inside a per-build directory:
# two concurrent builds (host auto-build, verifier, manual test) must never
# share one module cache, or swiftc reports "unable to load standard library".
build_dir="$here/helper/macos/.build"
mkdir -p "$build_dir"
work_dir=$(mktemp -d "$build_dir/build.XXXXXX")
cache_dir="$work_dir/module-cache"
tmp_dir="$work_dir/tmp"
mkdir -p "$cache_dir" "$tmp_dir"
export TMPDIR="$tmp_dir"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT INT TERM

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"

cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>SelectionAssistant</string>
  <key>CFBundleIdentifier</key>
  <string>com.evanliu3594.dsh-selection-assistant.helper</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>SelectionAssistant</string>
  <key>CFBundleDisplayName</key>
  <string>划词助手</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.1</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>MIT</string>
</dict>
</plist>
PLIST

files=$(find "$sources" -type f -name '*.swift' | sort)
if [ -z "$files" ]; then
  echo "error: no Swift sources under $sources" >&2
  exit 1
fi

compile() {
  target="$1"
  output="$2"
  # shellcheck disable=SC2086
  "$swiftc" -module-cache-path "$cache_dir" -O -swift-version 5 -target "$target" $files \
    -o "$output" -framework Cocoa -framework ApplicationServices
}

if [ "${1:-}" = "--universal" ]; then
  echo "compiling arm64..."
  compile arm64-apple-macosx13.1 "$work_dir/SelectionAssistant-arm64"
  echo "compiling x86_64..."
  compile x86_64-apple-macosx13.1 "$work_dir/SelectionAssistant-x86_64"
  lipo -create -output "$out" "$work_dir/SelectionAssistant-arm64" "$work_dir/SelectionAssistant-x86_64"
  target="universal (arm64 + x86_64), deployment macOS 13.1"
else
  compile "$native_target" "$out"
  target="$native_target"
fi

if command -v codesign >/dev/null 2>&1; then
  if ! codesign --force --sign - "$app" >/dev/null 2>&1; then
    echo "warning: ad-hoc codesign failed; macOS may reject the bundle" >&2
  fi
fi
chmod 755 "$out"
size=$(wc -c < "$out" | tr -d ' ')
echo "built $app ($size bytes inner binary, $target)"

if [ "${1:-}" = "--universal" ]; then
  if ! otool -arch arm64 -hv "$out" >/dev/null 2>&1; then
    echo "error: universal binary has no arm64 slice" >&2
    exit 1
  fi
fi
