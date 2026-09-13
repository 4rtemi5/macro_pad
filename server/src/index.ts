import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { RpcServer, RpcError, INVALID_PARAMS, INTERNAL_ERROR } from "./rpc.js";
import {
  ConfigStore,
  ensureConfigFile,
  profilesOf,
  statePatchSchema,
  validateConfigText,
  type ButtonAction,
} from "./config.js";
import { StateStore, type ButtonView } from "./state.js";
import { FocusWatcher } from "./focus.js";
import { ActivityLog } from "./activity.js";
import { printAccessInfo } from "./access.js";
import { setupPasscode } from "./passcode.js";
import { createShortcutExecutor, type BackendPreference } from "./actions/shortcut.js";
import { runScript, type ActionResult } from "./actions/script.js";

const VERSION = "0.1.0";
const AUTH_COOKIE = "macro_pad_token";
const MAX_WS_PAYLOAD = 64 * 1024; // messages are small JSON-RPC envelopes
const AUTH_FAIL_DELAY_MS = 250; // slow down passcode brute force

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function findWebDist(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    // global npm install: web/dist sits next to server/ inside the package
    path.resolve(moduleDir, "../../web/dist"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https: http:; connect-src 'self' ws: wss:; " +
    "base-uri 'none'; frame-ancestors 'none'",
};

/** Timing-safe comparison (hash first so length doesn't leak). */
function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieToken(req: http.IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function requestToken(req: http.IncomingMessage, url: URL): string | null {
  return url.searchParams.get("token") ?? cookieToken(req);
}

const HOSTNAME = os.hostname().toLowerCase();

/**
 * DNS-rebinding guard: only serve requests whose Host header is localhost,
 * an IP literal, or this machine's hostname. A browser tricked into loading
 * evil.com that resolves to this machine sends Host: evil.com and is refused.
 */
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // minimal non-browser clients
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1); // WHATWG keeps IPv6 brackets
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === HOSTNAME || hostname === `${HOSTNAME}.local`) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4 literal
  if (hostname.includes(":")) return true; // IPv6 literal
  return false;
}

/**
 * Cross-site WebSocket-hijacking guard: browsers always send Origin on WS
 * upgrades; require it to match the request's Host. Non-browser clients
 * (scripts, CLI) send no Origin and are allowed — they needed the passcode
 * anyway.
 */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Resolve a URL path inside the web root, or null if it escapes (via `..`,
 * encoded separators, or symlinks) or isn't a file.
 */
function resolveStatic(rootReal: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  rel = rel === "/" ? "index.html" : rel.replace(/^\/+/, "");
  const file = path.normalize(path.join(rootReal, rel));
  if (file !== rootReal && !file.startsWith(rootReal + path.sep)) return null;
  let real: string;
  try {
    real = fs.realpathSync(file); // collapse symlinks
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function sendFile(res: http.ServerResponse, file: string): void {
  // Vite emits content-hashed filenames under assets/ — safe to cache
  // forever. Everything else (index.html, sw.js, manifest, …) stays no-store
  // so updates and the service worker itself are picked up immediately.
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
}

function parseIdParam(params: unknown): number {
  const p = (params ?? {}) as Record<string, unknown>;
  const id = p.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new RpcError(INVALID_PARAMS, "params.id (non-negative integer) is required");
  }
  return id;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { file: configFile, created: configCreated } = ensureConfigFile();
  if (configCreated) {
    console.log(`[setup] created a starter config:\n  ${configFile}`);
  }
  // The config contains the passcode — keep it owner-only even if it was
  // created with a lax umask elsewhere.
  try {
    fs.chmodSync(configFile, 0o600);
  } catch {
    // best-effort
  }
  const configs = new ConfigStore(configFile);
  // Repair mode: a broken pad.json must never lock the user out of the
  // settings UI that fixes it.
  const repairMode = configs.loadSafe();
  configs.watch();
  if (!repairMode && !configCreated) console.log(`[config] loaded ${configFile}`);

  const initial = configs.current;

  // The pad executes arbitrary shell commands — it must never run without a
  // passcode, no matter which interface it binds to. An empty authToken is
  // the first-run sentinel: ask for a passcode (or generate one when
  // non-interactive) and save it to the config file. A missing authToken is
  // a config error; in repair mode (broken config at startup) fall back to
  // a printed ephemeral passcode so the settings page stays reachable.
  const envToken = process.env.MACRO_PAD_TOKEN;
  let configToken = initial.server.authToken;
  let ephemeralToken: string | null = null;
  if (!envToken && configToken === "" && !repairMode) {
    configToken = await setupPasscode(configFile);
  }
  if (!envToken && !configToken) {
    if (!repairMode) {
      throw new Error(
        "no passcode configured. The pad executes shell commands and refuses to run unauthenticated.\n" +
          '  Add to config/pad.json:  "server": { "authToken": "<long-random-string>", ... }\n' +
          '  Or leave it empty ("") to be asked on the next start.\n' +
          "  Or set env var:          MACRO_PAD_TOKEN=...",
      );
    }
    ephemeralToken = crypto.randomBytes(12).toString("hex");
    console.warn("[auth] config is broken and has no passcode — temporary passcode for this session:");
    console.warn(`[auth]   ${ephemeralToken}`);
  }
  const currentToken = (): string => envToken ?? configToken ?? ephemeralToken!;
  if (currentToken().length < 8) {
    throw new Error("passcode too short — authToken must be at least 8 characters");
  }

  // Mutable runtime network state — rebindable at runtime via config hot
  // reload or the server.restart RPC, no process restart needed.
  let activePort = initial.server.port;
  let activeBind = initial.server.bind;
  let activeBackendPref: BackendPreference = initial.server.shortcutBackend;

  const state = new StateStore(configs, path.join(path.dirname(configFile), "state.json"));
  state.loadToggles();
  let shortcut = await createShortcutExecutor(activeBackendPref);
  console.log(`[shortcut] backend: ${shortcut.name}`);

  const rpc = new RpcServer();
  const cfg = () => configs.current;
  const activity = new ActivityLog();

  // --- Active profile + focus auto-switching --------------------------------

  let activeProfileId = profilesOf(initial)[0].id;

  /** Switch the active profile and notify clients. Returns false for unknown ids. */
  const setActiveProfile = (id: string, reason: "manual" | "focus" | "config"): boolean => {
    if (!profilesOf(cfg()).some((p) => p.id === id)) return false;
    if (id === activeProfileId) return true;
    activeProfileId = id;
    console.log(`[profile] active: ${id} (${reason})`);
    rpc.notify("pad.profile", { activeProfile: id, reason });
    return true;
  };

  const hasProfileMatches = () =>
    profilesOf(cfg()).some((p) => (p.match?.apps.length ?? 0) > 0);

  const focusWatcher = new FocusWatcher({
    getOptions: () => ({
      pollMs: cfg().server.focus?.pollMs ?? 1000,
      command: cfg().server.focus?.command,
    }),
    hasMatches: hasProfileMatches,
    onAppChange: (appId) => {
      // First profile whose match.apps substring-matches the focused app id
      // wins. No match → keep the current profile (manual tab choice sticks).
      const match = profilesOf(cfg()).find((p) =>
        p.match?.apps.some((a) => appId.includes(a.toLowerCase())),
      );
      if (match && match.id !== activeProfileId) {
        console.log(`[focus] "${appId}" → profile "${match.id}"`);
        setActiveProfile(match.id, "focus");
      }
    },
  });
  focusWatcher.start();

  const activeProfile = () =>
    profilesOf(cfg()).find((p) => p.id === activeProfileId) ?? profilesOf(cfg())[0];

  rpc.method("pad.info", () => ({
    name: "macro-pad",
    version: VERSION,
    grid: activeProfile().grid,
    buttons: activeProfile().buttons.length,
    profiles: profilesOf(cfg()).length,
    focus: hasProfileMatches() ? focusWatcher.detectorName : "off",
    shortcutBackend: shortcut.name,
    clients: rpc.clientCount,
    bind: activeBind,
    port: activePort,
    auth: true,
    repair: repairMode,
  }));

  rpc.method("pad.getConfig", () => {
    const c = cfg();
    // never leak the passcode (or its absence) to clients
    const { authToken: _redacted, ...serverRest } = c.server;
    return { ...c, server: { ...serverRest, authToken: c.server.authToken ? "[redacted]" : undefined } };
  });

  rpc.method("pad.getState", () => state.snapshot(activeProfileId));

  rpc.method("pad.getLog", () => ({ entries: activity.list() }));

  rpc.method("pad.setProfile", (params) => {
    const id = (params as Record<string, unknown> | null)?.id;
    if (typeof id !== "string" || !setActiveProfile(id, "manual")) {
      throw new RpcError(INVALID_PARAMS, "params.id must be a known profile id");
    }
    return { ok: true, activeProfile: activeProfileId };
  });

  // Raw config access for the settings UI. Authenticated clients only — the
  // raw text includes authToken, which they by definition already possess.
  rpc.method("config.getRaw", () => {
    try {
      return { text: configs.getRaw() };
    } catch (err) {
      throw new RpcError(INTERNAL_ERROR, `cannot read config file: ${err instanceof Error ? err.message : err}`);
    }
  });

  rpc.method("config.setRaw", (params) => {
    const text = (params as Record<string, unknown> | null)?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new RpcError(INVALID_PARAMS, "params.text (non-empty string) is required");
    }
    try {
      configs.setRaw(text); // validates first; the file watcher applies + broadcasts
    } catch (err) {
      throw new RpcError(INVALID_PARAMS, err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  });

  // Live validation for the settings JSON editor — the same JSON + schema
  // checks as config.setRaw, but nothing is written.
  rpc.method("config.validate", (params) => {
    const text = (params as Record<string, unknown> | null)?.text;
    if (typeof text !== "string") {
      throw new RpcError(INVALID_PARAMS, "params.text (string) is required");
    }
    return validateConfigText(text);
  });

  rpc.method("button.press", async (params) => {
    const id = parseIdParam(params);
    const profileId = activeProfileId;
    const button = activeProfile().buttons.find((b) => b.id === id);
    if (!button) throw new RpcError(INVALID_PARAMS, `unknown button id ${id}`);

    const scriptEnv = () => ({
      MACRO_PAD_WS: `ws://127.0.0.1:${activePort}/rpc?token=${encodeURIComponent(currentToken())}`,
      MACRO_PAD_BUTTON_ID: String(id),
      MACRO_PAD_PROFILE: profileId,
    });
    const runSubAction = async (
      // prompt is handled separately (its text comes from the client), and
      // toggle sub-actions can't be prompt per the schema.
      action: Exclude<ButtonAction, { type: "toggle" | "prompt" }>,
    ): Promise<ActionResult> => {
      if (action.type === "shortcut") {
        await shortcut.press(action.keys, action.then);
        return { ok: true, exitCode: 0 };
      }
      if (action.type === "text") {
        if (action.method === "paste") await shortcut.pasteText(action.text);
        else await shortcut.typeText(action.text);
        return { ok: true, exitCode: 0 };
      }
      return runScript(action, (patch) => state.patch(profileId, id, patch), scriptEnv());
    };

    interface PressResult {
      ok: boolean;
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      error?: string;
      on?: boolean;
      backend?: string;
    }

    const execute = async (): Promise<PressResult> => {
      // Pure display tile (no action configured) — pressing is a no-op.
      if (!button.action) return { ok: true };

      // Prompt buttons: the text comes from the client (typed on the phone),
      // not from the config.
      if (button.action.type === "prompt") {
        const text = (params as Record<string, unknown> | null)?.text;
        if (typeof text !== "string" || !text || text.length > 4096) {
          throw new RpcError(INVALID_PARAMS, "prompt buttons require params.text (1-4096 chars)");
        }
        if (button.action.method === "paste") await shortcut.pasteText(text);
        else await shortcut.typeText(text);
        return { ok: true, exitCode: 0 };
      }

      if (button.action.type === "toggle") {
        // Optimistic latch: flip + broadcast immediately so the pad feels
        // instant, then run the matching sub-action. On failure, revert.
        const target = !state.isOn(profileId, id);
        state.setToggle(profileId, id, target);
        const result = await runSubAction(target ? button.action.on : button.action.off);
        if (!result.ok) {
          state.setToggle(profileId, id, !target);
          return { ok: false, on: !target, error: result.error ?? "action failed" };
        }
        return { ok: true, on: target };
      }

      const result = await runSubAction(button.action);
      if (button.action.type === "shortcut") {
        return { ...result, backend: shortcut.name };
      }
      return result;
    };

    // Record every press in the activity log (server log + pad.getLog) and
    // broadcast it to clients. User-entered text is never logged.
    const actionType = button.action?.type ?? "display";
    try {
      const result = await execute();
      rpc.notify(
        "pad.activity",
        activity.record({
          profile: profileId,
          button: id,
          label: button.label,
          action: actionType,
          ok: result.ok,
          error: result.ok ? undefined : (result.error ?? "action failed"),
        }),
      );
      return result;
    } catch (err) {
      rpc.notify(
        "pad.activity",
        activity.record({
          profile: profileId,
          button: id,
          label: button.label,
          action: actionType,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      throw err;
    }
  });

  rpc.method("button.setState", (params) => {
    const id = parseIdParam(params);
    const { id: _ignored, ...rest } = (params ?? {}) as Record<string, unknown>;
    const parsed = statePatchSchema.safeParse(rest);
    if (!parsed.success) {
      throw new RpcError(INVALID_PARAMS, "invalid state patch", parsed.error.issues);
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new RpcError(INVALID_PARAMS, "patch must set at least one of: color, glow, label, icon, content");
    }
    if (!state.patch(activeProfileId, id, parsed.data)) {
      throw new RpcError(INVALID_PARAMS, `unknown button id ${id}`);
    }
    return { ok: true };
  });

  // Re-apply server settings (port/bind/shortcutBackend) from the current
  // config without a process restart. The response is sent before the
  // listener is rebound, because rebinding drops this connection too.
  rpc.method("server.restart", () => {
    const s = cfg().server;
    const willRebind = s.port !== activePort || s.bind !== activeBind;
    const willChangeBackend = s.shortcutBackend !== activeBackendPref;
    if (willRebind || willChangeBackend) {
      setTimeout(() => {
        void applyServerSettings(s.port, s.bind, s.shortcutBackend).catch(() => {
          // logged + rolled back inside
        });
      }, 150);
    }
    return {
      ok: true,
      scheduled: willRebind || willChangeBackend,
      port: s.port,
      bind: s.bind,
      shortcutBackend: s.shortcutBackend,
    };
  });

  // Broadcast effective button views for the active profile. Views for other
  // profiles change silently — clients refetch when they switch tabs.
  state.on("update", (profileId: string, view: ButtonView) => {
    if (profileId === activeProfileId) rpc.notify("button.state", view);
  });
  configs.on("change", () => {
    console.log("[config] reloaded");
    // The active profile may have been renamed away or the config switched
    // between legacy and profiles shapes — fall back to the first profile.
    const profiles = profilesOf(configs.current);
    if (!profiles.some((p) => p.id === activeProfileId)) {
      setActiveProfile(profiles[0].id, "config");
    }
    const next = configs.current.server;
    // The passcode applies immediately (no restart needed). An empty token
    // never replaces the live one — it would be re-asked on the next start.
    if (!envToken && next.authToken && next.authToken !== configToken) {
      configToken = next.authToken;
      ephemeralToken = null;
      console.log("[auth] passcode updated from config");
    } else if (!envToken && next.authToken === "" && configToken) {
      console.warn("[auth] ignoring empty authToken — keeping the current passcode");
    }
    // Network/backend changes apply live by rebinding the listener.
    if (
      next.port !== activePort ||
      next.bind !== activeBind ||
      next.shortcutBackend !== activeBackendPref
    ) {
      void applyServerSettings(next.port, next.bind, next.shortcutBackend).catch(() => {
        // applyServerSettings logs and rolls back on failure
      });
    }
    rpc.notify("pad.config", { reason: "reload" });
  });
  configs.on("invalid", (err) => {
    console.warn(`[config] reload failed, keeping previous config: ${err instanceof Error ? err.message : err}`);
  });

  // --- HTTP ---------------------------------------------------------------
  // Static assets are served openly: the bundle contains no secrets, and the
  // passcode prompt lives in the web UI. Everything sensitive (the RPC
  // channel) requires the passcode.

  const webDist = findWebDist();
  const webDistReal = webDist ? fs.realpathSync(webDist) : null;

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end(msg);
    };

    if (!hostAllowed(req.headers.host)) return deny(403, "forbidden host");

    if (url.pathname === "/health") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }

    if (url.pathname === "/auth/check") {
      // Probe endpoint for the web UI's passcode prompt. 204 = passcode ok.
      if (tokenMatches(requestToken(req, url), currentToken())) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
      } else {
        setTimeout(() => deny(401, "unauthorized"), AUTH_FAIL_DELAY_MS);
      }
      return;
    }

    if (webDistReal) {
      const file = resolveStatic(webDistReal, url.pathname) ?? resolveStatic(webDistReal, "/");
      if (file) {
        sendFile(res, file);
        return;
      }
    }
    deny(404, webDistReal ? "not found" : "web app not built yet — run: npm run build -w web");
  };

  // --- WebSocket (JSON-RPC), passcode-gated --------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Writes to a socket whose client vanished mid-handshake must not crash us.
    socket.on("error", () => {});
    const fail = (code: number, msg: string) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      } catch {
        // client already gone
      }
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/rpc") return fail(404, "Not Found");
    if (!hostAllowed(req.headers.host)) return fail(403, "Forbidden");
    if (!originAllowed(req)) return fail(403, "Forbidden");
    if (!tokenMatches(requestToken(req, url), currentToken())) {
      // Same brute-force delay as /auth/check.
      setTimeout(() => fail(401, "Unauthorized"), AUTH_FAIL_DELAY_MS);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  rpc.attach(wss);

  // --- Rebindable listener ---------------------------------------------------
  // Applying port/bind changes never needs a process restart: close the
  // current listener (clients reconnect) and open a new one.

  let server: http.Server | null = null;

  async function rebind(newPort: number, newBind: "lan" | "local"): Promise<void> {
    const host = newBind === "lan" ? "::" : "127.0.0.1";
    if (server) {
      const old = server;
      server = null;
      rpc.closeAllClients(); // upgraded WS sockets aren't tracked by http.Server
      old.closeAllConnections();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        old.close(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const next = http.createServer(onRequest);
    next.on("upgrade", onUpgrade);
    await new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(newPort, host, () => {
        next.removeListener("error", reject);
        resolve();
      });
    });
    server = next;
    activePort = newPort;
    activeBind = newBind;
  }

  /** Apply server settings live; rolls back to the previous listener on failure. */
  async function applyServerSettings(
    newPort: number,
    newBind: "lan" | "local",
    backendPref: BackendPreference,
  ): Promise<{ rebound: boolean; backendChanged: boolean }> {
    let backendChanged = false;
    if (backendPref !== activeBackendPref) {
      shortcut = await createShortcutExecutor(backendPref);
      activeBackendPref = backendPref;
      backendChanged = true;
      console.log(`[shortcut] backend: ${shortcut.name}`);
    }
    let rebound = false;
    if (newPort !== activePort || newBind !== activeBind) {
      const prev = { port: activePort, bind: activeBind };
      try {
        await rebind(newPort, newBind);
        rebound = true;
        console.log(`[server] now listening on port ${newPort} (bind: ${newBind})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[server] rebind to ${newBind}:${newPort} failed (${msg}); keeping ${prev.bind}:${prev.port}`,
        );
        await rebind(prev.port, prev.bind).catch((e) =>
          console.error("[server] rollback failed:", e instanceof Error ? e.message : e),
        );
        throw new RpcError(
          INTERNAL_ERROR,
          `could not bind ${newBind}:${newPort}: ${msg} — still on ${prev.bind}:${prev.port}`,
        );
      }
    }
    return { rebound, backendChanged };
  }

  await rebind(activePort, activeBind);
  console.log(`macro-pad server on port ${activePort} (bind: ${activeBind}, auth: passcode required)`);
  printAccessInfo(activePort, activeBind, currentToken());
  if (webDistReal) console.log(`[static] serving web app from ${webDist}`);

  const shutdown = () => {
    console.log("\nshutting down");
    focusWatcher.stop();
    server?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Auto-run only when executed directly (node server/dist/index.js), not when
// imported by the CLI wrapper. realpath resolves npm's bin symlinks.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
