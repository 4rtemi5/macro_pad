# Macro Pad

A virtual macro keyboard: a grid of glowing, configurable buttons served as a
web app. Open it on your phone (same LAN as your computer), tap a button, and
the computer executes a keyboard shortcut or a shell script. Scripts can report
back and change the button's color, glow, label, or icon.

Everything is driven by **JSON-RPC 2.0 over WebSocket** — the web UI is just a
client, and your own scripts can connect too. See [PROTOCOL.md](PROTOCOL.md).

Inspired by the Work Louder Creator Micro 2
[hacking guide](https://github.com/schacon/micro-manager/blob/main/docs/hacking.md):
the server plays the firmware, `pad.json` is the keymap, and buttons are
threads — a lamp and an input on the same id.

## Quick start (your own Linux PC)

Requires Node.js 18+. One-line installer (installs the latest release, creates
a starter config, offers a login-autostart service, prints backend hints):

```bash
curl -fsSL https://raw.githubusercontent.com/4rtemi5/macro_pad/main/install.sh | bash
```

**Scan the QR code with your phone** (same Wi-Fi) — the pad opens already
authenticated; "Add to Home Screen" installs it as an app. No config editing:
the first run creates `~/.config/macro-pad/pad.json` from the showcase layout
([`config/pad.example.json`](config/pad.example.json) — media, meetings, dev
and herdr profiles demonstrating every feature) and asks you to choose a
passcode (saved back into the config).

Or install the latest release tarball manually:

```bash
npm install -g https://github.com/4rtemi5/macro_pad/releases/latest/download/macro-pad.tgz
macro-pad setup     # creates a starter config, prints a QR code
macro-pad start     # asks for a passcode on the first run
```

### CLI

```
macro-pad start              Start the server (default command)
macro-pad setup              Create the starter config, print the QR code
macro-pad qr                 Print the phone URL + QR code again
macro-pad open               Open the pad in this machine's browser
macro-pad service install    systemd user service — start at login
macro-pad service uninstall  Stop and remove the service
```

For key presses to actually type, install a backend: `xdotool` (X11) or
`ydotool` (Wayland — see the [backend table](#shortcut-backends) for setup).
Without one the server runs with a `noop` backend that only logs.

### Development (from source)

```bash
git clone https://github.com/4rtemi5/macro_pad.git && cd macro_pad
npm install
npm run dev       # server (tsx watch) + web (Vite) with hot reload
```

- Web UI (Vite dev server): `http://localhost:5173`
- **From your phone:** `http://<computer-ip>:5173`

### Production-ish (from source)

```bash
npm run build   # builds web/ and server/
npm start       # serves UI + RPC on port 8787 — phone: http://<computer-ip>:8787
```

## Install as an app (PWA)

The web UI is a Progressive Web App: a service worker pre-caches the app shell
(so it opens instantly and shows the reconnecting state even when the server
is down) and a web manifest makes it installable to your phone's home screen
with the neon-keycap icon.

One caveat: browsers only enable service workers and install prompts in
**secure contexts** — HTTPS, or `localhost`/`127.0.0.1`. What that means in
practice:

| How you open the pad                     | Result                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| `http://localhost:8787` (same machine)   | Full PWA — installable, offline shell                          |
| `http://<lan-ip>:8787` on iOS Safari     | "Add to Home Screen" gives a standalone full-screen app (no SW) |
| `http://<lan-ip>:8787` on Android Chrome | Opens in a browser tab; install prompt needs HTTPS             |
| HTTPS via Tailscale Serve / mkcert       | Full PWA everywhere                                            |

For full PWA support on your own network without PKI pain,
[Tailscale Serve](https://tailscale.com/kb/1312/serve) fronts the server with
a valid HTTPS cert on your tailnet; [mkcert](https://github.com/FiloSottile/mkcert)
works too if you're willing to install a local CA on the phone. Plain HTTP
keeps working exactly as before either way — the PWA bits are purely additive.

Note: on iOS, the home-screen app has storage separate from Safari, so you'll
re-enter the passcode once after installing.

The settings page has a **Keep screen on** switch (off by default, remembered
per device) built on the Screen Wake Lock API. It follows the same
secure-context rule: over plain LAN HTTP it renders disabled with an
explanation. If you don't want HTTPS, Android Chrome can whitelist the pad's
origin via `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

## Security model

The pad is a remote shell-command executor by design, so it is built to be
watertight on a local network:

- **Passcode required, always.** The server exits at startup if no
  `server.authToken` (min 8 chars) or `MACRO_PAD_TOKEN` is configured; an
  empty `authToken` makes the first start ask for one and save it. The
  passcode is required for every WebSocket RPC connection (`?token=` or auth
  cookie) and is compared timing-safe; failed probes are delayed.
- **LAN-only by default, never internet-exposed.** `server.bind: "lan"` serves
  your local network so your phone can connect; `"local"` binds `127.0.0.1`
  only. Only run this on networks you trust — there is no TLS, so don't expose
  the port to the internet.
- **DNS-rebinding guard.** Requests whose `Host` header is not `localhost`, an
  IP literal, or this machine's hostname are refused (HTTP 403).
- **WebSocket-hijacking guard.** Browser WS upgrades whose `Origin` doesn't
  match the request host are refused — a malicious website can't drive your pad
  from your browser.
- **No secret leakage.** `pad.getConfig` redacts `authToken`; static files are
  served with a strict CSP, `nosniff`, `no-store`, and path-traversal/symlink
  protection; WS payloads are capped at 64 KiB.
- The web UI keeps the passcode in `localStorage` + a `SameSite=Strict` cookie
  and scrubs `?token=` from the URL bar after first use.

## Configuration

Buttons live in [`config/pad.json`](config/pad.json). The easiest way to edit
them is the **settings page in the app** (gear icon, top right): a visual
editor plus a raw JSON mode, with an expandable reference of every option.
**Drag a button card's grip handle to reorder** (keyboard: focus the grip,
Space to lift, arrows to move, Space to drop) — the pad lays out buttons in
config order, and ids stay put so script references keep working.
Saving validates first — invalid JSON never touches the running config — and
applies immediately via hot-reload.

You can also edit the file directly while the server runs; it hot-reloads and
all connected clients re-render (`pad.config` notification). Everything
applies live — buttons, `authToken`, and even `server.port` / `bind` /
`shortcutBackend`: the server rebinds its listener in place (clients
reconnect; external tools can trigger the same via the `server.restart` RPC).
If the file is broken at startup, the server starts in **repair mode** (empty
pad, temporary passcode printed to the console) so the settings page stays
reachable to fix it.

```jsonc
{
  "grid": { "rows": 4, "cols": 4 },
  "server": {
    "port": 8787,
    "bind": "lan",                // "lan" | "local"
    "shortcutBackend": "auto",
    "authToken": "..."            // min 8 chars; "" = ask on startup and save
  },
  "buttons": [
    {
      "id": 0,
      "label": "Mute Mic",
      "icon": "fa:microphone-slash", // emoji, fa:icon-name (FontAwesome; far:/fab:
                                     // for regular/brand icons), short text/unicode
                                     // (hollow backlit legend), or image URL/path
      "color": "#ff2d2d",
      "glow": "solid",              // off | solid | breathing
      "action": { "type": "shortcut", "keys": ["ctrl", "shift", "m"] }
    },
    {
      "id": 8,
      "label": "Idle",
      "action": {
        "type": "script",
        "command": "./scripts/example-toggle.sh",
        "timeoutMs": 30000,
        "onError": { "color": "#ff2d2d", "glow": "breathing" }
      }
    }
  ]
}
```

Scripts report state by printing a JSON patch as their last stdout line:

```bash
echo '{"color":"#00c853","glow":"breathing","label":"Live"}'
```

### Key sequences (prefix chords)

A shortcut's `keys` are one chord (pressed together, released in reverse). Add
`then` to press follow-up chords after the first is released — this is how
prefix-style apps like **herdr** or tmux are driven (`ctrl+b`, then the action
key):

```jsonc
{ "id": 2, "label": "Split →", "icon": "fa:table-columns",
  "action": { "type": "shortcut", "keys": ["ctrl", "b"], "then": [["v"]] } }
// herdr's "split right" (prefix+v): sends ctrl+b, then v, with a beat between
```

In the settings UI the same thing is written in the keys field with semicolons
separating chords: `ctrl, b; v`.

The bundled [`config/pad.example.json`](config/pad.example.json) is a full
showcase — and it's also the starter config written on first run: four
profiles (Media, Meetings, Dev, herdr) using every action type, display
tiles, spans, toggles, live script patches — and a complete herdr control
layout (splits, pane navigation, tabs, sidebar, detach, cheatsheet tile) that
works with a stock herdr install. Delete the profiles you don't need; the
settings UI (gear icon) edits everything live.

### Toggle buttons (latching)

A button with `"type": "toggle"` behaves like a latching switch: every press
flips a server-tracked on/off flag and runs the matching sub-action. While on,
the key stays lit and slightly depressed. The state **survives server
restarts** (persisted to `state.json` next to `pad.json`) and reverts
automatically if the sub-action fails.

Because a failed sub-action reverts the latch, make toggle commands
idempotent — "already off" must exit 0, or the latch refuses to undo. Classic
trap: `pkill -f 'some pattern'` exits 1 when nothing matches *and* can match
its own shell's command line; write it as `pkill -f '[s]ome pattern' || true`
(the `[s]` bracket keeps the pattern from matching itself).

```jsonc
{
  "id": 4,
  "label": "Mic",
  "icon": "fa:microphone",
  "action": {
    "type": "toggle",
    "on":  { "type": "script", "command": "wpctl set-mute @DEFAULT_SOURCE@ 0" },
    "off": { "type": "script", "command": "wpctl set-mute @DEFAULT_SOURCE@ 1" },
    "onState": { "glow": "solid", "color": "#00c853" }  // optional; default {"glow":"solid"}
  }
}
```

### Text insertion & display tiles

A `"type": "text"` action types text into the focused app — snippets,
addresses, canned responses:

```jsonc
{ "id": 6, "label": "Email", "icon": "fa:at",
  "action": { "type": "text", "text": "me@example.com" } }
// method: "paste" sets the clipboard (xclip/wl-copy) + ctrl+v instead of
// simulating keystrokes — instant for long text, but clobbers the clipboard
```

A `"type": "prompt"` action is the same idea, but the text is typed **on the
phone** at tap time — a sheet slides up, you type, hit Insert, and it's
typed/pasted into the focused app. Great for replies, search queries, or
one-off snippets:

```jsonc
{ "id": 9, "label": "Reply", "icon": "💬",
  "action": { "type": "prompt", "placeholder": "Type a reply…" } }
// method: "paste" works here too; placeholder is the optional input hint
```

Tiles can also **display** text or markdown: set `content` (optionally
`contentType: "markdown"`), optionally widen the tile with `w`/`h` (span in
grid cells, default 1×1), and omit `action` for a pure display tile that
doesn't respond to taps:

```jsonc
{ "id": 7, "w": 2, "color": "#134e4a",
  "content": "## Status\nAll **systems** go", "contentType": "markdown" }
```

`content` is part of the state-patch schema, so scripts can update it live —
print a patch as the last stdout line and the tile's face updates:

```jsonc
{ "id": 8, "label": "Uptime", "icon": "fa:arrows-rotate",
  "action": { "type": "script",
    "command": "echo \"{\\\"content\\\":\\\"$(uptime -p)\\\"}\"" } }
```

### Profiles (tabs) with focus auto-switching

Replace the top-level `grid`/`buttons` with a `profiles` list to get a tab bar
on the pad — one layout per app or context. When the focused window's app id
contains one of a profile's `match.apps` strings (case-insensitive), the pad
switches to it automatically; tapping a tab switches manually, and manual
choices stick when no profile matches.

```jsonc
{
  "server": { "authToken": "...", "focus": { "pollMs": 1000 } },
  "profiles": [
    {
      "id": "gaming",
      "name": "Gaming",
      "icon": "🎮",
      "match": { "apps": ["steam", "heroic"] },
      "grid": { "rows": 2, "cols": 3 },
      "buttons": [ { "id": 0, "label": "Clip", "action": { "type": "shortcut", "keys": ["alt", "f10"] } } ]
    },
    {
      "id": "work",
      "name": "Work",
      "icon": "fa:briefcase",
      "match": { "apps": ["code", "firefox"] },
      "grid": { "rows": 2, "cols": 3 },
      "buttons": [ { "id": 0, "label": "Standup", "action": { "type": "script", "command": "xdg-open https://meet.example.com" } } ]
    }
  ]
}
```

Button ids only need to be unique **within** a profile; runtime state (patches
and toggles) is tracked per profile. Legacy single-layout configs keep working
unchanged — they behave as one implicit `default` profile.

The foreground-app detector is auto-detected at startup:

| Detector      | Environment        | Notes                                             |
| ------------- | ------------------ | ------------------------------------------------- |
| `swaymsg`     | Sway / wlroots     | reads the focused container's `app_id`            |
| `hyprctl`     | Hyprland           | reads the active window's `class`                 |
| `xdotool`     | X11                | reads `WM_CLASS`; on Wayland only sees XWayland   |
| custom command | any               | `server.focus.command` — must print the app id    |

GNOME Wayland has no built-in CLI for this — set `server.focus.command` to a
one-liner that prints the focused app id. The
[focused-window-dbus](https://github.com/flexagoon/focused-window-dbus)
extension exposes it over D-Bus, after which this works:

```jsonc
"focus": {
  "pollMs": 500,
  "command": "gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/FocusedWindow --method org.gnome.Shell.Extensions.FocusedWindow.Get | grep -oP \"'app_id': <'\\K[^']+\""
}
```

Anything that prints an app id on stdout works. `pollMs` (250–10000, default
1000) controls how often it runs. Auto-switching is only active when at least
one profile has `match.apps`.

## Shortcut backends

Keystroke injection is pluggable (`server.shortcutBackend` in `pad.json`):

| Backend   | Platform            | Install                                       |
| --------- | ------------------- | --------------------------------------------- |
| `auto`    | —                   | picks the first available of the ones below   |
| `ydotool` | Linux/Wayland       | https://github.com/ReimuNotMoe/ydotool        |
| `xdotool` | Linux/X11           | `apt install xdotool`                         |
| `nutjs`   | Linux/macOS/Windows | `npm install @nut-tree/nut-js -w server`      |
| `noop`    | any                 | logs only — for development without a desktop |

Key names: modifiers `ctrl`/`shift`/`alt`/`super`, `enter`, `esc`, `space`,
`tab`, `backspace`, `delete`, arrows, `f1`–`f24`, single letters/digits, and
media keys `play`/`stop`/`next`/`prev`/`volup`/`voldown`/`mute`.

Raw keycode passthrough (backend-specific, not available on `nutjs`):

| Syntax        | Backend | Meaning                                             |
| ------------- | ------- | --------------------------------------------------- |
| `"code:36"`   | xdotool | raw X11 keycode (8–255)                             |
| `"U+00E9"`    | xdotool | Unicode code point keysym (types `é`)               |
| `"sym:dead_acute"` | xdotool | any X keysym name, verbatim                    |
| `"XF86LaunchA"`   | xdotool | extended `XF86…` keysyms pass through directly |
| `"ev:30"`     | ydotool | raw Linux input event code (0–767, `KEY_MAX`)       |

## External clients / scripts

Anything that can open a WebSocket can drive the pad — see
[PROTOCOL.md](PROTOCOL.md). A ready-made CLI client:

```bash
export MACRO_PAD_TOKEN=<your passcode>
node scripts/cli.mjs press 8
node scripts/cli.mjs set 8 '{"color":"#00c853","glow":"breathing"}'
node scripts/cli.mjs listen   # watch button.state notifications
```

Scripts launched by the server receive `MACRO_PAD_WS` (with the passcode
included), `MACRO_PAD_BUTTON_ID`, and `MACRO_PAD_PROFILE` in their environment.

## Layout

```
config/pad.json      profiles/button grid + actions (hot-reloaded; installed
                     runs use ~/.config/macro-pad/pad.json instead)
config/state.json    persisted toggle states (written by the server)
install.sh           one-line installer (npm global install + setup + service)
server/              Node.js: JSON-RPC dispatcher, config/state stores, executors, CLI
web/                 React + Vite phone UI (PWA)
scripts/             example macro scripts + cli.mjs RPC client
PROTOCOL.md          JSON-RPC method reference
```
