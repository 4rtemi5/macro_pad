# Macro Pad JSON-RPC Protocol

The macro pad server speaks **JSON-RPC 2.0 over a single WebSocket** at
`ws://<host>:<port>/rpc` (default port `8787`). The web UI is just one client —
any process that can open a WebSocket can drive the pad or listen to it.

Inspired by the Work Louder firmware protocol: the server plays the role of the
firmware (owns config, state, and actions), buttons are "threads" (a lamp and an
input on the same id), and state changes are pushed as notifications.

## Envelope

Request:

```json
{ "jsonrpc": "2.0", "method": "button.press", "params": { "id": 3 }, "id": 1 }
```

Success response:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }
```

Error response:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "unknown button id 42" } }
```

Server notification (no `id`, never answered):

```json
{ "jsonrpc": "2.0", "method": "button.state", "params": { "id": 3, "color": "#00c853", "actionType": "script" } }
```

Standard error codes are used: `-32700` parse error, `-32600` invalid request,
`-32601` method not found, `-32602` invalid params, `-32603` internal error.
Unknown methods answer `-32601 Method not found` — like the firmware, use that
to probe what a server supports.

## Methods (client → server)

### `pad.info`

Server identity and capabilities.

- Params: none
- Result: `{ "name", "version", "grid": { "rows", "cols" }, "buttons", "profiles", "focus", "shortcutBackend", "clients", "bind", "port", "auth", "repair" }`
  (`grid`/`buttons` describe the active profile; `profiles` is the profile
  count; `focus` is the foreground-app detector name — `"swaymsg"`,
  `"hyprctl"`, `"xdotool"`, `"custom command"` — or `"off"` when no profile
  has `match.apps` or no detector is available)

### `pad.getConfig`

The raw, validated contents of `pad.json` (includes full action definitions —
treat as sensitive on shared networks).

- Params: none
- Result: the config object

### `pad.getState`

The merged snapshot the UI renders: the active profile's buttons overlaid with
runtime state patches and toggle states, **in config array order** (the pad's
layout order). Actions are reduced to `actionType`
only. Call once after connecting, then keep up to date via notifications.

- Params: none
- Result:
  ```json
  {
    "profiles": [{ "id": "gaming", "name": "Gaming", "icon": "🎮" }],
    "activeProfile": "gaming",
    "grid": { "rows": 2, "cols": 3 },
    "buttons": [{ "id": 3, "label"?, "icon"?, "color"?, "glow"?, "content"?, "contentType"?, "w"?, "h"?, "actionType"?, "placeholder"?, "on"? }]
  }
  ```
  `actionType` is `"shortcut" | "script" | "text" | "prompt" | "toggle"` and
  omitted for pure display tiles (no action configured). `placeholder` is
  present for `prompt` buttons only (the input hint for the client's text
  entry). `on` is present for `toggle` buttons only. `w`/`h` are the tile's span in grid columns/rows (omitted when
  1×1). `content` (rendered as `contentType`: `"text"` default or
  `"markdown"`) takes over the keycap face instead of icon/label. Legacy
  single-layout configs report one implicit profile with id `"default"`.

`icon` forms (resolved by the web UI): an emoji (`"🎙️"`), a FontAwesome name
(`"fa:microphone-slash"` — solid; `far:`/`fab:` prefixes select the
regular/brand packs), any other short text/unicode (`"⌘"`, `"OK"` — drawn as a
hollow backlit legend), or an image URL/path (`"/x.png"`, `"https://…"`,
`"data:…"`).

### `pad.setProfile`

Switch the active profile (what the web UI's tab bar does).

- Params: `{ "id": "<profile id>" }`
- Result: `{ "ok": true, "activeProfile": "<id>" }`
- Errors: `-32602` unknown profile id
- Broadcasts `pad.profile` with `reason: "manual"`; clients should re-call
  `pad.getState`.

### `button.press`

Execute a button's action. Button ids resolve within the **active profile**.

- Params: `{ "id": <integer>, "text"?: string }` — `text` is **required** for
  `prompt` actions (1–4096 chars; it's what the user typed on the client) and
  ignored otherwise.
- Result for `shortcut` actions: `{ "ok": true, "backend": "xdotool" | "ydotool" | "nutjs" | "noop" }`
- Result for `text` actions: `{ "ok": true, "exitCode": 0 }` — the text is
  inserted into the focused app, by simulated keystrokes (`method: "type"`,
  default) or via the clipboard (`method: "paste"`: set clipboard through
  `xclip`/`wl-copy`, then ctrl+v — instant for long text but clobbers the
  clipboard; falls back to typing when the clipboard tool is missing)
- Result for `prompt` actions: `{ "ok": true, "exitCode": 0 }` — like `text`,
  but the inserted text comes from `params.text` instead of the config.
  `-32602` when `text` is missing, not a string, empty, or over 4096 chars.
- Result for `script` actions: `{ "ok", "exitCode", "stdout"?, "stderr"?, "error"? }`
  (`stdout`/`stderr` truncated to the last 4000 chars; `error: "timeout"` when killed)
- Result for `toggle` actions: `{ "ok": true, "on": boolean }` — the state
  flips **optimistically** (a `button.state` notification is broadcast
  immediately and the new state persisted), then the matching `on`/`off`
  sub-action runs. If that action fails, the state reverts, another
  `button.state` notification goes out, and the result is
  `{ "ok": false, "on": <previous>, "error": string }`.
  Sub-actions are `shortcut`, `script`, or `text`.
- Result for a button with **no action** (pure display tile): `{ "ok": true }`
  — pressing is a no-op.
- Errors: `-32602` unknown id

Shortcut `keys` are pressed in order and released in reverse (chord semantics).
An optional `then` list holds up to 4 follow-up chords pressed in sequence
after the main chord is released (with a ~50 ms gap) — for prefix-style UIs
like herdr/tmux: `keys: ["ctrl","b"], then: [["c"]]` sends `ctrl+b`, then `c`.
Beyond the portable names (`ctrl`, `shift`, `alt`, `super`, `enter`, `esc`,
arrows, `f1`–`f24`, letters/digits, `play`/`stop`/`next`/`prev`/`volup`/
`voldown`/`mute`), two backends accept raw passthrough forms:

- xdotool: `"code:<8-255>"` (raw X11 keycode), `"U+<hex>"` (Unicode code point,
  e.g. `"U+00E9"` types `é`), `"sym:<name>"` (any X keysym verbatim), and bare
  `XF86…` keysyms (e.g. `"XF86LaunchA"`).
- ydotool: `"ev:<0-767>"` (raw Linux input event code, see
  `/usr/include/linux/input-event-codes.h`).
- nutjs: no passthrough — using one of these forms fails with a clear error.

### `config.getRaw`

Raw text of `pad.json`, exactly as on disk — may be invalid JSON if the file
was broken by an external edit (the server keeps running on the last good
config). Powers the settings UI's JSON editor.

- Params: none
- Result: `{ "text": string }`
- Note: the raw text includes `authToken`; authenticated clients already hold
  the passcode, so this leaks nothing extra.

### `config.setRaw`

Validate and replace `pad.json`. The file is only written if the text parses
as JSON **and** matches the config schema — otherwise the running config is
untouched. On success the file watcher applies the change and broadcasts
`pad.config` to all clients.

- Params: `{ "text": string }`
- Result: `{ "ok": true }`
- Errors: `-32602` with a readable message (`invalid JSON: …` or
  `config does not match schema: …` with the first issues)
- Note: everything applies live — `authToken` immediately, and
  `server.port`/`bind`/`shortcutBackend` by rebinding the listener (all
  clients are dropped and reconnect). If the port changed, clients must
  reconnect to the new address.

### `config.validate`

The same JSON + schema checks as `config.setRaw`, but nothing is written —
powers live checking in the settings UI's JSON editor.

- Params: `{ "text": string }`
- Result: `{ "ok": boolean, "syntaxError"?: string, "issues": [{ "path", "message" }] }`
  (`syntaxError` when the text isn't valid JSON; otherwise up to 10 schema
  issues with dotted paths like `"buttons.0.color"`)

### `server.restart`

Re-apply `server.port` / `bind` / `shortcutBackend` from the current config
without a process restart. The response is sent first; ~150 ms later the
listener is closed and reopened, so **this connection (and every other) is
dropped** — reconnect afterwards. If the new bind fails (e.g. port in use),
the server rolls back to the previous address and logs the error.

- Params: none
- Result: `{ "ok": true, "scheduled": boolean, "port", "bind", "shortcutBackend" }`
  (`scheduled: false` when nothing changed)

### `button.setState`

Patch a button's runtime visual state. This is the method external scripts and
integrations call to drive the pad. Omitted fields stay unchanged. Button ids
resolve within the **active profile**, and patches are tracked per profile —
the same id in two profiles has independent state.

- Params: `{ "id": <integer>, "color"?: "#rrggbb", "glow"?: "off" | "solid" | "breathing", "label"?: string, "icon"?: string, "content"?: string, "contentType"?: "text" | "markdown" }`
  (at least one field required; `content: ""` clears the display text)
- Result: `{ "ok": true }`
- Errors: `-32602` unknown id, empty patch, or invalid fields

### `pad.getLog`

The recent activity log: the last 100 button executions (newest first), kept
in memory for the lifetime of the server process. Every entry is also written
to the server log (`journalctl --user -u macro-pad` when running as a
service). User-entered text (prompt/text action content) is never logged.

- Params: none
- Result: `{ "entries": [ { "ts": <epoch ms>, "profile": "<id>", "button": <id>, "label"?: string, "action": "shortcut" | "script" | "text" | "prompt" | "toggle" | "display", "ok": boolean, "error"?: string } ] }`

## Notifications (server → all clients)

### `button.state`

A button in the **active profile** changed its effective view. Params are the
full merged button view: `{ "id", "label"?, "icon"?, "color"?, "glow"?,
"content"?, "contentType"?, "w"?, "h"?, "actionType"?, "on"? }` — clients
should merge these fields over their copy of the button. Fired when:

- a script prints a JSON patch on stdout or hits its `onSuccess`/`onError` patch
- any client calls `button.setState`
- a toggle button flips (including the revert after a failed sub-action)

Changes in non-active profiles are not broadcast; clients refetch on
`pad.profile` instead.

### `pad.profile`

The active profile changed. Params:
`{ "activeProfile": "<id>", "reason": "manual" | "focus" | "config" }` —
`manual` when a client called `pad.setProfile`, `focus` when the
foreground-app watcher auto-switched, `config` when a reload removed the
previously active profile. Clients should re-call `pad.getState`.

### `pad.config`

`pad.json` was edited and hot-reloaded. Params: `{ "reason": "reload" }`.
Runtime patches are cleared on reload (toggle states are **not** — entries for
deleted or no-longer-toggle buttons are pruned); clients should re-call
`pad.getState`.

### `pad.activity`

A button was pressed and its action finished (or failed). Params are a single
activity entry, same shape as the `pad.getLog` entries: `{ "ts", "profile",
"button", "label"?, "action", "ok", "error"? }`. The settings UI uses this to
update its Recent activity list live.

## Toggle state persistence

The on/off state of toggle buttons is stored server-side in `state.json` next
to `pad.json` (debounced, atomic write), keyed `"<profileId>:<buttonId>"`:

```json
{ "toggles": { "gaming:3": true } }
```

It survives config reloads and server restarts. Deleting or hand-editing the
file is safe — missing or broken files just start with everything off.

## Script conventions

Scripts run via `button.press` get three environment variables:

- `MACRO_PAD_WS` — WebSocket URL of this server's RPC endpoint
- `MACRO_PAD_BUTTON_ID` — id of the button that triggered the script
- `MACRO_PAD_PROFILE` — id of the profile the button belongs to

Two ways for a script to update its button (or any other):

1. **Stdout patch (simplest).** If the last non-empty stdout line parses as a
   JSON object matching the state-patch schema, it is applied to the triggering
   button. Example: `echo '{"color":"#00c853","glow":"breathing"}'`
2. **Call back over RPC.** Connect to `$MACRO_PAD_WS` and call
   `button.setState` — works for long-running daemons, other buttons, and
   updates long after the script exits.

Patch order when a script finishes: `onSuccess`/`onError` from the config first,
then the stdout patch (stdout wins).

## Authentication & transport security

**A passcode is mandatory.** The server refuses to start unless
`server.authToken` (min 8 chars) is set in `pad.json` or `MACRO_PAD_TOKEN` is
in the environment. An empty `authToken` (`""`) is the first-run sentinel: the
server asks for a passcode on the terminal (or generates one when
non-interactive) and saves it back into `pad.json`. The pad executes arbitrary
shell commands by design — never expose the port outside a trusted local
network (there is no TLS).

WebSocket clients authenticate by either:

- query param: `ws://<host>:<port>/rpc?token=<passcode>`, or
- cookie: a `macro_pad_token=<passcode>` cookie sent with the upgrade request
  (what the web UI uses after you enter the passcode once).

The upgrade is refused with HTTP 401 otherwise. Comparisons are timing-safe and
failed attempts at the probe endpoint are delayed by 250 ms.

Additional transport guards:

- `GET /auth/check?token=<passcode>` → `204` if the passcode is valid, `401`
  otherwise. The web UI uses this for its passcode prompt.
- **Host allowlist** (DNS-rebinding guard): requests are only served when the
  `Host` header is `localhost`/`*.localhost`, an IP literal, or the machine's
  hostname. Anything else → `403`.
- **Origin check** on the WS upgrade (cross-site WebSocket-hijacking guard): a
  browser `Origin` header must match the request host. Clients that send no
  `Origin` (scripts, CLIs) are unaffected.
- `pad.getConfig` redacts `authToken`.
- WS messages are capped at 64 KiB; HTTP responses send a strict CSP,
  `nosniff`, `no-store`, and `cross-origin-resource-policy: same-origin`.
- `server.bind: "lan"` (default) listens on all interfaces for phone access;
  `"local"` binds `127.0.0.1` only.

## Minimal external client (Node)

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/rpc?token=" + process.env.MACRO_PAD_TOKEN);
let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    const onMsg = (data) => {
      const msg = JSON.parse(data);
      if (msg.id !== myId) return;
      ws.off("message", onMsg);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id: myId }));
  });

ws.on("open", async () => {
  await call("button.setState", { id: 8, color: "#00c853", glow: "breathing" });
  ws.close();
});
```
