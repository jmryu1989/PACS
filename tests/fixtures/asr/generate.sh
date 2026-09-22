#!/bin/sh
# S3-ASR-U3 fixture generator entry point. Runs inside the generator image only, with
# --network none, and writes two files into the mounted output directory:
#
#   espeak-raw.wav  the pinned non-clinical sentence as eSpeak NG synthesised it
#   generator.json  the exact command, the built binary identity and the raw WAV hash
#
# There is no model, no recognition, no microphone and no recorded human speech here. The
# sentence is the one pinned by the accepted S3-ASR-U0b card and must not be edited into
# clinical text.
set -eu

out="${1:-/out}"
sentence='The blue square is next to the green circle.'
voice='en-us'
speed='150'

espeak-ng -v "$voice" -s "$speed" -w "$out/espeak-raw.wav" "$sentence"

raw_sha="$(sha256sum "$out/espeak-raw.wav" | cut -d' ' -f1)"
raw_bytes="$(wc -c < "$out/espeak-raw.wav" | tr -d ' ')"

printf '{"name":"espeak-ng","source":{"tag":"%s","tag_object":"%s","commit":"%s"},"binary":{"path":"%s","sha256":"%s","version_banner":"%s"},"command":["espeak-ng","-v","%s","-s","%s","-w","espeak-raw.wav","%s"],"raw_wav":{"sha256":"%s","bytes":%s},"content":"synthetic non-clinical text-to-speech; no recording and no patient data"}\n' \
  "$(cat /kin/tag)" "$(cat /kin/tag_object)" "$(cat /kin/commit)" \
  "$(cat /kin/path)" "$(cat /kin/binsha)" "$(cat /kin/version)" \
  "$voice" "$speed" "$sentence" \
  "$raw_sha" "$raw_bytes" > "$out/generator.json"

cat "$out/generator.json"
