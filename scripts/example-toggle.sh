#!/usr/bin/env bash
# Example macro script for the macro pad.
#
# Toggles between "Idle" and "Live" and reports the new button state by
# printing a JSON state patch as the last line of stdout. The server applies
# that patch to the button that ran the script and broadcasts it to all
# connected clients.
#
# Environment provided by the server:
#   MACRO_PAD_WS         WebSocket URL of the JSON-RPC endpoint
#   MACRO_PAD_BUTTON_ID  id of the button that triggered this script
set -euo pipefail

STATE_FILE="${TMPDIR:-/tmp}/macro-pad-example-toggle"

if [ -f "$STATE_FILE" ]; then
  rm "$STATE_FILE"
  echo "Going idle"
  echo '{"color":"#3a3f4b","glow":"off","label":"Idle","icon":"💤"}'
else
  touch "$STATE_FILE"
  echo "Going live"
  echo '{"color":"#00c853","glow":"breathing","label":"Live","icon":"🔴"}'
fi
