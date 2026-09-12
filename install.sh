#!/usr/bin/env bash
# Macro Pad one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/4rtemi5/macro_pad/main/install.sh | bash
#
# What it does:
#   1. checks for Node.js >= 18 and npm
#   2. installs the latest GitHub release tarball globally (npm i -g <url>)
#   3. creates a starter config (macro-pad setup) — the passcode is chosen
#      on the first `macro-pad start`
#   4. optionally installs a systemd user service (starts at login)
#   5. prints setup guidance for keystroke injection (xdotool / ydotool)
#
# For local testing of a packed tarball instead of the release URL:
#   ./install.sh ./macro-pad-0.1.0.tgz
set -euo pipefail

PKG="https://github.com/4rtemi5/macro_pad/releases/latest/download/macro-pad.tgz"
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    *) PKG="$arg" ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

say "==> Checking Node.js"
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 18+ first:
  Debian/Ubuntu:  sudo apt install nodejs npm
  Fedora:         sudo dnf install nodejs-npm
  Arch:           sudo pacman -S nodejs npm
  or via nvm:     https://github.com/nvm-sh/nvm"
command -v npm  >/dev/null 2>&1 || die "npm not found — install it with your Node.js package"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $NODE_MAJOR is too old — macro-pad needs Node 18+"
info "node $(node --version) ✓"

say "==> Installing macro-pad"
if ! npm i -g "$PKG"; then
  die "npm i -g failed. If this was a permission error (EACCES), don't use sudo —
  set up a user-level prefix instead: https://docs.npmjs.com/resolving-eacces-permissions-errors"
fi
command -v macro-pad >/dev/null 2>&1 || die "macro-pad installed but not on PATH — check your npm global bin dir (npm bin -g)"

say "==> Creating config"
macro-pad setup

echo
if [ "$YES" = "1" ]; then
  REPLY=y
else
  read -r -p "Install a systemd user service so macro-pad starts at login? [Y/n] " REPLY
fi
case "${REPLY:-y}" in
  [nN]*) info "skipped — start manually with: macro-pad start" ;;
  *)
    if command -v systemctl >/dev/null 2>&1; then
      macro-pad service install || info "service install failed — start manually with: macro-pad start"
    else
      info "systemctl not found — start manually with: macro-pad start"
    fi
    ;;
esac

echo
say "==> Keystroke injection backend"
case "${XDG_SESSION_TYPE:-x11}" in
  wayland)
    info "Wayland detected — install ydotool for key presses to work:"
    info "  Debian/Ubuntu:  sudo apt install ydotool"
    info "  Fedora:         sudo dnf install ydotool"
    info "  Arch:           sudo pacman -S ydotool"
    info "Then: sudo usermod -aG input \$USER && systemctl --user enable --now ydotoold  (log out/in once)"
    ;;
  *)
    info "X11 detected — install xdotool for key presses to work:"
    info "  Debian/Ubuntu:  sudo apt install xdotool"
    info "  Fedora:         sudo dnf install xdotool"
    info "  Arch:           sudo pacman -S xdotool"
    ;;
esac
info "Without a backend the pad still runs (noop backend) but buttons won't type."

echo
say "Done! Start with:  macro-pad start"
info "Then scan the QR code with your phone and 'Add to Home Screen'."
