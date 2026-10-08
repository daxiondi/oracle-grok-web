#!/usr/bin/env bash
# Attach Oracle to an already-running GeekEZ ChatGPT profile.
# Dots uses an isolated runtime; ordinary ChatGPT keeps the installed Oracle.
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
ORACLE_BIN="${ORACLE_GEEKEZ_ORACLE_BIN:-$HOME/.nvm/versions/node/v24.16.0/bin/oracle}"

# Resolve direct URLs and stored follow-ups without exposing session contents.
TARGET_URL=$(python3 - "$@" <<'PY'
import json, os, pathlib, re, sys
args = sys.argv[1:]
target = None
parent = None
for i, arg in enumerate(args):
    for flag in ('--chatgpt-url', '--browser-url'):
        if arg == flag and i + 1 < len(args):
            target = args[i + 1]
        elif arg.startswith(flag + '='):
            target = arg.split('=', 1)[1]
    if arg == '--followup' and i + 1 < len(args):
        parent = args[i + 1]
    elif arg.startswith('--followup='):
        parent = arg.split('=', 1)[1]
if parent and '/' not in parent and '\\' not in parent:
    root = pathlib.Path(os.environ.get('ORACLE_HOME_DIR', pathlib.Path.home() / '.oracle'))
    try:
        meta = json.loads((root / 'sessions' / parent / 'meta.json').read_text())
        browser = meta.get('browser', {})
        for candidate in (browser.get('harvest', {}).get('url'), browser.get('runtime', {}).get('tabUrl')):
            if candidate:
                target = candidate
                break
    except (OSError, ValueError, AttributeError):
        pass
if target:
    match = re.fullmatch(r'https://chatgpt\.com/dots/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?(?:[?#][^\s\\]*)?', target.strip(), re.I)
    if match:
        target = 'https://chatgpt.com/dots/' + match.group(1).lower()
print(target or '')
PY
)

case "$TARGET_URL" in
  https://chatgpt.com/dots/*)
    ORACLE_BIN="${ORACLE_GEEKEZ_ORACLE_BIN:-${ORACLE_GEEKEZ_DOTS_BIN:-$HOME/.local/share/oracle-dots/current/dist/bin/oracle-cli.js}}"
    ;;
esac
if [ ! -f "$ORACLE_BIN" ]; then
  echo "Oracle runtime not found: $ORACLE_BIN" >&2
  exit 1
fi

PROFILE_PORT="${ORACLE_GEEKEZ_PORT:-}"
if [ -z "$PROFILE_PORT" ]; then
  # Inspect only GeekEZ profile endpoints; never start or replace a browser.
  PROFILE_PORT=$(python3 - "$TARGET_URL" <<'PY'
import json, pathlib, sys, urllib.parse, urllib.request
target = sys.argv[1]
root = pathlib.Path.home() / 'Library/Application Support/geekez-browser/BrowserProfiles'
candidates = {}
for path in root.glob('*/browser_data/DevToolsActivePort'):
    try:
        port = int(path.read_text().splitlines()[0])
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2) as response:
            tabs = json.load(response)
        urls = [tab.get('url', '') for tab in tabs if tab.get('type') == 'page']
        score = 2 if target and target in urls else 1 if any(
            urllib.parse.urlparse(url).hostname == 'chatgpt.com' for url in urls
        ) else 0
        candidates[port] = score
    except (OSError, ValueError, IndexError):
        pass
if not candidates:
    sys.exit('No running GeekEZ profile found. Start your ChatGPT profile in GeekEZ first.')
best = max(candidates.values())
ports = [port for port, score in candidates.items() if score == best]
if len(ports) != 1:
    sys.exit('Multiple GeekEZ profiles match. Set ORACLE_GEEKEZ_PORT to the intended ChatGPT profile port.')
print(ports[0])
PY
  )
fi

if ! curl -fsS --max-time 3 "http://127.0.0.1:${PROFILE_PORT}/json/version" >/dev/null; then
  echo "GeekEZ CDP endpoint 127.0.0.1:${PROFILE_PORT} is unavailable." >&2
  exit 4
fi
echo "GeekEZ profile Chrome on 127.0.0.1:${PROFILE_PORT}" >&2

HAS_SLUG=0
for arg in "$@"; do
  case "$arg" in --slug|--slug=*) HAS_SLUG=1; break ;; esac
done
DEFAULT_SLUG_ARGS=()
if [ "$HAS_SLUG" -eq 0 ]; then
  DEFAULT_SLUG_ARGS=(--slug "geekez-oracle-$(date +%H%M%S)")
fi

exec node "$ORACLE_BIN" \
  --engine browser \
  --browser-attach-running \
  --remote-chrome "127.0.0.1:${PROFILE_PORT}" \
  --model "5.5 Pro" \
  --browser-model-strategy current \
  --browser-archive never \
  --no-notify \
  --timeout 2h \
  --browser-timeout 2h \
  --browser-input-timeout 5m \
  --browser-attachment-timeout 15m \
  --browser-profile-lock-timeout 5m \
  --browser-recheck-delay 2m \
  --browser-recheck-timeout 5m \
  --browser-auto-reattach-delay 2m \
  --browser-auto-reattach-timeout 5m \
  ${DEFAULT_SLUG_ARGS[@]+"${DEFAULT_SLUG_ARGS[@]}"} \
  "$@"
