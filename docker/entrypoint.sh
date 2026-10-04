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
  # an AMD card is reached through /dev/kfd and /dev/dri/renderD*, which
  # belong to the host's render and video groups. Those groups are kept, or
  # the ROCm build cannot open the GPU once root is dropped
  GROUPS_ARG="--clear-groups"
  DEV_GIDS="$(stat -c %g /dev/kfd /dev/dri/renderD* 2>/dev/null | sort -u | paste -sd, -)"
  [ -n "$DEV_GIDS" ] && GROUPS_ARG="--groups=$DEV_GIDS"
  exec setpriv --reuid="$PUID" --regid="$PGID" "$GROUPS_ARG" \
    node /app/out/server/index.js
fi

exec node /app/out/server/index.js
