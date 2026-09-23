#!/bin/zsh
# One-time: build whisper.cpp (pinned) + the base.en model into Library/tools, shared by both
# build slots and untouched by updates. Used for word-precise clip boundaries in reels.
source "${0:A:h}/common.sh"
set -e
TAG=v1.9.4
DIR="$LIB/tools/whisper.cpp"
CMAKE=$(command -v cmake || echo /usr/local/opt/cmake/bin/cmake)
mkdir -p "$LIB/tools"
[ -d "$DIR/.git" ] || git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$DIR"
cd "$DIR"
"$CMAKE" -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DGGML_CCACHE=OFF -DGGML_METAL=OFF >/dev/null
"$CMAKE" --build build -j 8 --config Release --target whisper-cli >/dev/null
[ -f models/ggml-base.en.bin ] || sh models/download-ggml-model.sh base.en >/dev/null
./build/bin/whisper-cli --help >/dev/null 2>&1 && log "whisper.cpp $TAG ready: $DIR/build/bin/whisper-cli"
