#!/usr/bin/env bash
# Build whisper.cpp for FreeShow's STT engine.
# Run from FreeShow root: ./scripts/build-whisper.sh
#
# This builds whisper-cli and whisper-server from the git submodule at src/electron/stt/whisper.cpp.
# Models are downloaded on first use via the STT settings UI.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WHISPER_DIR="$ROOT_DIR/src/electron/stt/whisper.cpp"
CLI_BINARY_PATH="$WHISPER_DIR/build/bin/whisper-cli"
SERVER_BINARY_PATH="$WHISPER_DIR/build/bin/whisper-server"

echo "=== Building whisper.cpp for FreeShow ==="

# Check if already built
if [ -f "$CLI_BINARY_PATH" ] && [ -f "$SERVER_BINARY_PATH" ] && [ "$1" != "--force" ]; then
    echo "whisper-cli already built at $CLI_BINARY_PATH"
    echo "whisper-server already built at $SERVER_BINARY_PATH"
    echo "Skipping build. Use './scripts/build-whisper.sh --force' to rebuild."
    exit 0
fi

# Ensure submodule is initialised
if [ ! -f "$WHISPER_DIR/CMakeLists.txt" ]; then
    echo "Initializing whisper.cpp submodule..."
    cd "$ROOT_DIR"
    git submodule update --init --recursive src/electron/stt/whisper.cpp
fi

# Configure
echo "Configuring..."
cd "$WHISPER_DIR"
cmake -B build \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DCMAKE_BUILD_TYPE=Release

# Build the CLI fallback and persistent server backend.
echo "Building whisper-cli and whisper-server..."
cmake --build build -j --config Release --target whisper-cli whisper-server

# Verify
if [ -f "$CLI_BINARY_PATH" ] && [ -f "$SERVER_BINARY_PATH" ]; then
    echo ""
    echo "=== Build successful ==="
    echo "  CLI:    $CLI_BINARY_PATH"
    echo "  Server: $SERVER_BINARY_PATH"
else
    echo "ERROR: whisper binaries not found after build"
    exit 1
fi

# Optionally download a starter model
if [ "$1" = "--with-model" ]; then
    MODEL="${2:-base.en}"
    if [ ! -f "$WHISPER_DIR/models/ggml-${MODEL}.bin" ]; then
        echo "Downloading ${MODEL} model..."
        sh "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL"
    else
        echo "Model ${MODEL} already downloaded."
    fi
fi

echo "=== Done ==="
