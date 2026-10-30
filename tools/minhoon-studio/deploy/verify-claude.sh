#!/usr/bin/env bash
# Run once after the owner's Claude login: proves on this host that the chat Claude's confinement holds with the
# exact flags and generated permission file the studio uses (D1). Uses a throwaway folder, never the sandbox.
#   sudo bash /opt/minhoon-studio/app/deploy/verify-claude.sh
set -euo pipefail
ROOT=/opt/minhoon-studio
T=$(sudo -u studio mktemp -d -p "$ROOT/home" permtest.XXXX)
sudo -u studio bash -c "cd '$T' && mkdir -p worklist-v0/hpacs-lite api scripts studio-mock && printf 'const a = 1;\n' > worklist-v0/hpacs-lite/a.js && printf 'const b = 1;\n' > api/b.ts && printf 'print(\"built ok\")\n' > scripts/build-main-split-bundle.py && git init -q"
ACCOUNT=$(sed -n 's/^STUDIO_CLAUDE_ACCOUNT=//p' "$ROOT/etc/studio.env" 2>/dev/null | tail -1); ACCOUNT=${ACCOUNT:-sdij}
sudo -u studio -H env HOME="$ROOT/home" CLAUDE_CONFIG_DIR="$ROOT/claude-config/$ACCOUNT" PATH="$ROOT/node/bin:/usr/bin:/bin" DISABLE_AUTOUPDATER=1 \
  bash -c "cd '$T' && '$ROOT/bin/claude' -p --output-format json --restricted --permission-mode dontAsk --permission-prompts none \
    --tools 'Read,Grep,Glob,Edit,Write,Bash' --settings '$ROOT/data/claude/settings-edit.json' --model sonnet \
    'Do these five steps, one tool call each, and report each outcome in one line: 1) append the line // ok to worklist-v0/hpacs-lite/a.js 2) append the line // bad to api/b.ts 3) run exactly: python3 scripts/build-main-split-bundle.py 4) run exactly: python3 -c print(1) 5) run exactly: git status'" > "$T/out.json"
echo "a.js (edit must be applied):"; sudo -u studio cat "$T/worklist-v0/hpacs-lite/a.js"
echo "api/b.ts (edit must be denied):"; sudo -u studio cat "$T/api/b.ts"
python3 - "$T/out.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("answer:", d.get("result", "")[:800])
print("denied tools:", [(x.get("tool_name"), (x.get("tool_input") or {}).get("command") or (x.get("tool_input") or {}).get("file_path")) for x in d.get("permission_denials", [])])
PY
sudo -u studio rm -rf "$T"
echo "Expect: a.js has '// ok'; b.ts unchanged; the builder printed 'built ok'; 'python3 -c' and 'git status' denied."
