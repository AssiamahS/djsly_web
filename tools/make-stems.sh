#!/usr/bin/env bash
# Split tracks into Serato-style stems (vocals / melody / bass / drums) with Demucs, ready for djsly.
# usage: tools/make-stems.sh "song.mp3" ["another.m4a" ...]      output: ~/djsly-stems/<song>/{vocals,other,bass,drums}.mp3
# then in djsly → Library → "Stems" on that track → pick the 4 mp3s (or the folder on desktop Chrome).
set -euo pipefail
command -v demucs >/dev/null || { echo "demucs not found: pip3 install demucs"; exit 1; }
OUT="${DJSLY_STEMS_DIR:-$HOME/djsly-stems}"
mkdir -p "$OUT"
demucs -n htdemucs --mp3 --mp3-bitrate 192 -o "$OUT/.work" "$@"
for f in "$@"; do
  name="$(basename "${f%.*}")"
  mkdir -p "$OUT/$name"
  mv "$OUT/.work/htdemucs/$name/"*.mp3 "$OUT/$name/"
  echo "→ $OUT/$name"
done
rm -rf "$OUT/.work"
