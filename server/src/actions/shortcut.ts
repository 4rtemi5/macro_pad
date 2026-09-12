import { spawn, spawnSync } from "node:child_process";

export interface ShortcutExecutor {
  readonly name: string;
  /**
   * Press all keys in order, then release them in reverse (chord semantics).
   * `then` chords are pressed afterwards, one at a time, with a short gap —
   * for prefix-style UIs (herdr/tmux send "ctrl+b" then the action key).
   */
  press(keys: string[], then?: string[][]): Promise<void>;
  /** Insert text by simulating individual keystrokes. */
  typeText(text: string): Promise<void>;
  /**
   * Insert text via the clipboard (set clipboard, then ctrl+v). Instant for
   * long text, but clobbers the clipboard. Falls back to typeText when no
   * clipboard tool (xclip/wl-copy) is available.
   */
  pasteText(text: string): Promise<void>;
}

function hasBinary(bin: string): boolean {
  const r = spawnSync("which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    );
  });
}

/** Like run(), but pipes `input` to the process's stdin (clipboard tools). */
function runWithStdin(bin: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    );
    child.stdin!.end(input);
  });
}

/** Gap between the main chord and each `then` chord (prefix-mode UIs need a beat). */
const CHORD_GAP_MS = 50;

/** Press the main chord, then each follow-up chord in sequence. */
async function pressSequence(
  pressChord: (keys: string[]) => Promise<void>,
  keys: string[],
  then?: string[][],
): Promise<void> {
  await pressChord(keys);
  for (const chord of then ?? []) {
    await new Promise((r) => setTimeout(r, CHORD_GAP_MS));
    await pressChord(chord);
  }
}

// ---------------------------------------------------------------------------
// noop — logs only. The "fake device" mode: develop the pad without a desktop.
// ---------------------------------------------------------------------------

const noopExecutor: ShortcutExecutor = {
  name: "noop",
  async press(keys, then) {
    const seq = [keys, ...(then ?? [])].map((chord) => chord.join("+")).join(" then ");
    console.log(`[shortcut:noop] ${seq}`);
  },
  async typeText(text) {
    console.log(`[shortcut:noop] type ${JSON.stringify(text)}`);
  },
  async pasteText(text) {
    console.log(`[shortcut:noop] paste ${JSON.stringify(text)}`);
  },
};

// ---------------------------------------------------------------------------
// xdotool (X11)
// ---------------------------------------------------------------------------

const XDOTOOL_KEYS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  meta: "super",
  super: "super",
  cmd: "super",
  win: "super",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  space: "space",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  minus: "minus",
  equal: "equal",
  comma: "comma",
  period: "period",
  slash: "slash",
  backslash: "backslash",
  semicolon: "semicolon",
  quote: "apostrophe",
  play: "XF86AudioPlay",
  stop: "XF86AudioStop",
  next: "XF86AudioNext",
  prev: "XF86AudioPrev",
  volup: "XF86AudioRaiseVolume",
  voldown: "XF86AudioLowerVolume",
  mute: "XF86AudioMute",
};

/**
 * Passthrough syntax (xdotool only):
 *   "code:<n>"   raw X11 keycode, 8-255            — "code:36"
 *   "U+<hex>"    Unicode code point keysym         — "U+00E9" -> é
 *   "sym:<name>" any X keysym name, verbatim       — "sym:dead_acute"
 *   "XF86…"      extended keysyms pass through     — "XF86LaunchA"
 */
function xdotoolKey(k: string): string {
  const lower = k.toLowerCase();
  if (XDOTOOL_KEYS[lower]) return XDOTOOL_KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if (/^[a-z0-9]$/.test(lower)) return lower;
  const code = /^code:(\d+)$/i.exec(k);
  if (code) {
    const n = Number(code[1]);
    if (n >= 8 && n <= 255) return String(n);
    throw new Error(`xdotool keycode out of range (8-255): "${k}"`);
  }
  const uni = /^u\+([0-9a-f]{4,6})$/i.exec(k) ?? /^u([0-9a-f]{4})$/i.exec(k);
  if (uni) return `U${uni[1].toUpperCase()}`;
  const sym = /^sym:([A-Za-z0-9_]+)$/.exec(k);
  if (sym) return sym[1];
  if (/^XF86[A-Za-z0-9_]+$/i.test(k)) return k;
  throw new Error(`unsupported key for xdotool backend: "${k}"`);
}

const xdotoolExecutor: ShortcutExecutor = {
  name: "xdotool",
  press(keys, then) {
    const chord = (ks: string[]) => run("xdotool", ["key", ks.map(xdotoolKey).join("+")]);
    return pressSequence(chord, keys, then);
  },
  typeText(text) {
    return run("xdotool", ["type", "--delay", "12", "--", text]);
  },
  async pasteText(text) {
    if (!hasBinary("xclip")) {
      console.warn("[shortcut:xdotool] xclip not found — typing instead of pasting");
      return this.typeText(text);
    }
    await runWithStdin("xclip", ["-selection", "clipboard"], text);
    return this.press(["ctrl", "v"]);
  },
};

// ---------------------------------------------------------------------------
// ydotool (Wayland / uinput) — needs Linux input event codes
// ---------------------------------------------------------------------------

const YDOTOOL_CODES: Record<string, number> = {
  esc: 1,
  escape: 1,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  minus: 12,
  equal: 13,
  backspace: 14,
  tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  enter: 28,
  return: 28,
  ctrl: 29,
  control: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  semicolon: 39,
  quote: 40,
  shift: 42,
  backslash: 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51,
  period: 52,
  slash: 53,
  alt: 56,
  space: 57,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
  home: 102,
  up: 103,
  pageup: 104,
  left: 105,
  right: 106,
  end: 107,
  down: 108,
  pagedown: 109,
  insert: 110,
  delete: 111,
  del: 111,
  mute: 113,
  voldown: 114,
  volup: 115,
  next: 163,
  play: 164,
  prev: 165,
  stop: 166,
  super: 125,
  meta: 125,
  cmd: 125,
  win: 125,
};

/**
 * Passthrough syntax (ydotool only): "ev:<n>" — raw Linux input event code,
 * 0-767 (KEY_MAX); see /usr/include/linux/input-event-codes.h.
 */
function ydotoolCode(k: string): number {
  const named = YDOTOOL_CODES[k.toLowerCase()];
  if (named !== undefined) return named;
  const ev = /^ev:(\d+)$/i.exec(k);
  if (ev) {
    const n = Number(ev[1]);
    if (n <= 767) return n;
    throw new Error(`ydotool evdev code out of range (0-767): "${k}"`);
  }
  throw new Error(`unsupported key for ydotool backend: "${k}"`);
}

const ydotoolExecutor: ShortcutExecutor = {
  name: "ydotool",
  press(keys, then) {
    const chord = (ks: string[]) => {
      const codes = ks.map(ydotoolCode);
      const args = [
        ...codes.map((c) => `${c}:1`), // all down
        ...codes.reverse().map((c) => `${c}:0`), // all up, reverse order
      ];
      return run("ydotool", ["key", ...args]);
    };
    return pressSequence(chord, keys, then);
  },
  typeText(text) {
    return run("ydotool", ["type", "--", text]);
  },
  async pasteText(text) {
    if (!hasBinary("wl-copy")) {
      console.warn("[shortcut:ydotool] wl-copy not found — typing instead of pasting");
      return this.typeText(text);
    }
    await runWithStdin("wl-copy", [], text);
    return this.press(["ctrl", "v"]);
  },
};

// ---------------------------------------------------------------------------
// nut.js (@nut-tree/nut-js) — optional, cross-platform. Install with:
//   npm install @nut-tree/nut-js -w server
// ---------------------------------------------------------------------------

async function nutjsExecutor(): Promise<ShortcutExecutor> {
  const nut = await import("@nut-tree/nut-js");
  const { keyboard, Key } = nut;
  type NutKey = unknown;

  const named: Record<string, NutKey> = {
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    shift: Key.LeftShift,
    alt: Key.LeftAlt,
    meta: Key.LeftSuper,
    super: Key.LeftSuper,
    cmd: Key.LeftSuper,
    win: Key.LeftSuper,
    enter: Key.Enter,
    return: Key.Enter,
    esc: Key.Escape,
    escape: Key.Escape,
    space: Key.Space,
    tab: Key.Tab,
    backspace: Key.Backspace,
    delete: Key.Delete,
    del: Key.Delete,
    insert: Key.Insert,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    play: Key.AudioPlay,
    stop: Key.AudioStop,
    next: Key.AudioNext,
    prev: Key.AudioPrev,
    volup: Key.AudioVolUp,
    voldown: Key.AudioVolDown,
    mute: Key.AudioMute,
  };

  function resolve(k: string): NutKey {
    const lower = k.toLowerCase();
    if (named[lower]) return named[lower];
    if (/^[a-z0-9]$/.test(lower) && Key[lower.toUpperCase()] !== undefined) {
      return Key[lower.toUpperCase()];
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower) && Key[lower.toUpperCase()] !== undefined) {
      return Key[lower.toUpperCase()];
    }
    if (/^(code:|ev:|sym:)/i.test(k) || /^u\+?[0-9a-f]{4,}$/i.test(k) || /^xf86/i.test(k)) {
      throw new Error(
        `raw keycode passthrough ("${k}") is not supported by the nutjs backend — use xdotool or ydotool`,
      );
    }
    throw new Error(`unsupported key for nutjs backend: "${k}"`);
  }

  return {
    name: "nutjs",
    async press(keys, then) {
      const chord = async (ks: string[]) => {
        const resolved = ks.map(resolve);
        for (const k of resolved) await keyboard.pressKey(k);
        for (const k of [...resolved].reverse()) await keyboard.releaseKey(k);
      };
      await pressSequence(chord, keys, then);
    },
    async typeText(text) {
      await keyboard.type(text);
    },
    async pasteText(text) {
      console.warn("[shortcut:nutjs] clipboard paste not supported — typing instead");
      await keyboard.type(text);
    },
  };
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export type BackendPreference = "auto" | "nutjs" | "xdotool" | "ydotool" | "noop";

export async function createShortcutExecutor(preference: BackendPreference): Promise<ShortcutExecutor> {
  const tryNutjs = async (): Promise<ShortcutExecutor | null> => {
    try {
      return await nutjsExecutor();
    } catch {
      return null;
    }
  };
  const warn = (msg: string) => {
    console.warn(`[shortcut] ${msg}; falling back to noop`);
    return noopExecutor;
  };

  switch (preference) {
    case "noop":
      return noopExecutor;
    case "xdotool":
      return hasBinary("xdotool") ? xdotoolExecutor : warn("xdotool not found (apt install xdotool)");
    case "ydotool":
      return hasBinary("ydotool") ? ydotoolExecutor : warn("ydotool not found (https://github.com/ReimuNotMoe/ydotool)");
    case "nutjs":
      return (await tryNutjs()) ?? warn("@nut-tree/nut-js not installed (npm i @nut-tree/nut-js -w server)");
    case "auto": {
      if (process.env.WAYLAND_DISPLAY && hasBinary("ydotool")) return ydotoolExecutor;
      if (process.env.DISPLAY && hasBinary("xdotool")) return xdotoolExecutor;
      if (hasBinary("xdotool")) return xdotoolExecutor;
      if (hasBinary("ydotool")) return ydotoolExecutor;
      const nut = await tryNutjs();
      if (nut) return nut;
      return warn("no backend available (install xdotool or ydotool, or npm i @nut-tree/nut-js -w server)");
    }
  }
}
