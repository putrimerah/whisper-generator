#!/usr/bin/env bash
# Install the WSL-side runtime for whisper-generator.
# No sudo required: ffmpeg is a static user-level binary, Whisper lives in a venv.
# Safe to re-run; each step is skipped when already satisfied.
set -euo pipefail

VENV="${WG_VENV:-$HOME/.wg/venv}"
BIN="${WG_BIN:-$HOME/.local/bin}"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
# large-v3 fits a 6 GB GPU on CTranslate2 at int8_float16 (~3.5 GB).
PREFETCH_MODEL="${WG_MODEL:-large-v3}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "1/4 ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "already installed: $(command -v ffmpeg)"
else
  mkdir -p "$BIN" /tmp/wg-ffmpeg
  cd /tmp/wg-ffmpeg
  curl -fL --retry 3 -o ff.tar.xz "$FFMPEG_URL"
  tar xf ff.tar.xz
  src="$(find . -maxdepth 1 -type d -name 'ffmpeg-master*' | head -1)"
  install -m755 "$src/bin/ffmpeg" "$BIN/ffmpeg"
  install -m755 "$src/bin/ffprobe" "$BIN/ffprobe"
  cd - >/dev/null
  rm -rf /tmp/wg-ffmpeg
  echo "installed: $BIN/ffmpeg"
fi
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "WARNING: $BIN is not on PATH. Add: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
esac

log "2/4 python venv at $VENV"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip wheel >/dev/null
echo "$("$VENV/bin/python" -V) ready"

log "3/4 whisper-ctranslate2 + CUDA libs (~2.5 GB download, 3-10 min)"
if "$VENV/bin/python" -c "import ctranslate2" >/dev/null 2>&1; then
  echo "already installed"
else
  # CTranslate2 runtime instead of PyTorch: ~1.5 GB instead of ~6.5 GB, ~4x
  # faster, and large-v3 fits a 6 GB GPU at int8_float16.
  "$VENV/bin/pip" install whisper-ctranslate2
fi

# CTranslate2 links against cuBLAS 12 and cuDNN 9 but does not depend on them,
# so pip skips them and the GPU run dies with
# "Library libcublas.so.12 is not found". Install them explicitly.
# They land in site-packages/nvidia/*/lib; `wg` adds that to LD_LIBRARY_PATH.
if "$VENV/bin/python" -c "import nvidia.cublas, nvidia.cudnn" >/dev/null 2>&1; then
  echo "cuda libs already installed"
else
  "$VENV/bin/pip" install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
fi

log "4/4 verify"
"$VENV/bin/python" - <<'PY'
import shutil
import ctranslate2
print("ctranslate2:", ctranslate2.__version__)
print("cuda dev   :", ctranslate2.get_cuda_device_count())
print("ffmpeg     :", shutil.which("ffmpeg") or "MISSING")
PY
"$VENV/bin/whisper-ctranslate2" --help >/dev/null && echo "cli        : $VENV/bin/whisper-ctranslate2"

if [ -n "$PREFETCH_MODEL" ]; then
  log "prefetching '$PREFETCH_MODEL' into ~/.cache/huggingface (skip with WG_MODEL=)"
  # CTranslate2 weights come from HuggingFace, not the OpenAI .pt cache.
  "$VENV/bin/python" -c "
from faster_whisper import WhisperModel
WhisperModel('$PREFETCH_MODEL', device='cpu', compute_type='int8')
" >/dev/null
  echo "cached"
fi

log "done"
cat <<EOF
Whisper CLI   : $VENV/bin/whisper-ctranslate2   (wg finds this automatically)
Check anytime : wg doctor
EOF
