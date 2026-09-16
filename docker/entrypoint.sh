#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-022}"

mkdir -p "$STEMKIT_DATA" "$HOME" "$XDG_CACHE_HOME" "$TORCH_HOME"

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # hand the data folder to the configured user. Only entries with the wrong
  # owner are touched, so a big song library does not slow every start
  find "$STEMKIT_DATA" \( ! -user "$PUID" -o ! -group "$PGID" \) \
    -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups \
    node /app/out/server/index.js
fi

exec node /app/out/server/index.js
