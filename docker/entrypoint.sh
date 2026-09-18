#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-022}"

# the library and the checkpoints can be sent to their own mounts; unset
# they stay where they have always been, under the data folder
: "${STEMKIT_SONGS:=$STEMKIT_DATA/songs}"
: "${STEMKIT_MODELS:=$STEMKIT_DATA/models}"
: "${TORCH_HOME:=$STEMKIT_MODELS/torch}"
export STEMKIT_SONGS STEMKIT_MODELS TORCH_HOME

mkdir -p "$STEMKIT_DATA" "$STEMKIT_SONGS" "$STEMKIT_MODELS" "$HOME" "$XDG_CACHE_HOME" "$TORCH_HOME"

# anything already inside the data folder is covered by the sweep over it
OWNED="$STEMKIT_DATA"
case "$STEMKIT_SONGS" in "$STEMKIT_DATA"/*) ;; *) OWNED="$OWNED $STEMKIT_SONGS" ;; esac
case "$STEMKIT_MODELS" in "$STEMKIT_DATA"/*) ;; *) OWNED="$OWNED $STEMKIT_MODELS" ;; esac

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # hand the data folders to the configured user. Only entries with the wrong
  # owner are touched, so a big song library does not slow every start
  # shellcheck disable=SC2086
  find $OWNED \( ! -user "$PUID" -o ! -group "$PGID" \) \
    -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups \
    node /app/out/server/index.js
fi

exec node /app/out/server/index.js
