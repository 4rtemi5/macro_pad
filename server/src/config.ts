import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

/** A partial visual update for a button. All fields optional; omitted fields stay unchanged. */
export const statePatchSchema = z
  .object({
    color: hexColor.optional(),
    glow: z.enum(["off", "solid", "breathing"]).optional(),
    label: z.string().max(64).optional(),
    icon: z.string().max(512).optional(),
    /** Display text/markdown taking over the keycap face ("" clears it). */
    content: z.string().max(4096).optional(),
    /** How `content` is rendered. Default: "text". */
    contentType: z.enum(["text", "markdown"]).optional(),
  })
  .strict();

/** One chord: key names pressed together, released in reverse. */
const chordSchema = z.array(z.string().min(1)).min(1).max(8);

const shortcutActionSchema = z.object({
  type: z.literal("shortcut"),
  /** e.g. ["ctrl", "shift", "m"] — pressed in order, released in reverse. */
  keys: chordSchema,
  /**
   * Optional follow-up chords pressed in sequence after the main chord is
   * released — for prefix-style UIs like herdr/tmux: keys ["ctrl","b"] plus
   * then [["c"]] sends "ctrl+b, then c".
   */
  then: z.array(chordSchema).min(1).max(4).optional(),
});

const textActionSchema = z.object({
  type: z.literal("text"),
  /** Text inserted into the focused application. */
  text: z.string().min(1).max(4096),
  /**
   * "type" (default): simulate keystrokes (xdotool/ydotool type, nutjs) —
   * clipboard untouched. "paste": set the clipboard (xclip/wl-copy) and press
   * ctrl+v — instant for long text, but clobbers the clipboard, needs the
   * clipboard tool installed, and ctrl+v doesn't work in every app.
   */
  method: z.enum(["type", "paste"]).optional(),
});

/**
 * Like "text", but the text is entered on the client at press time: tapping
 * the tile opens an input on the phone, and whatever is typed there gets
 * inserted into the focused app. The client sends it as params.text of
 * button.press.
 */
const promptActionSchema = z.object({
  type: z.literal("prompt"),
  /** Same semantics as the text action's method. */
  method: z.enum(["type", "paste"]).optional(),
  /** Hint shown in the client's input field. */
  placeholder: z.string().max(64).optional(),
});

const scriptActionSchema = z.object({
  type: z.literal("script"),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  /** State patch applied when the script exits 0. */
  onSuccess: statePatchSchema.optional(),
  /** State patch applied when the script fails or times out. */
  onError: statePatchSchema.optional(),
});

const subActionSchema = z.discriminatedUnion("type", [
  shortcutActionSchema,
  scriptActionSchema,
  textActionSchema,
]);

/**
 * Latching toggle: each press flips the server-tracked `on` flag and runs the
 * matching sub-action. `onState` is the visual applied while on (default:
 * solid glow). Toggle state persists across restarts (state.json).
 */
const toggleActionSchema = z.object({
  type: z.literal("toggle"),
  /** Runs when the toggle switches on. */
  on: subActionSchema,
  /** Runs when the toggle switches off. */
  off: subActionSchema,
  /** Visual patch applied while the toggle is on. Defaults to a solid glow. */
  onState: statePatchSchema.optional(),
});

const buttonSchema = z.object({
  id: z.number().int().min(0).max(999),
  label: z.string().max(64).optional(),
  icon: z.string().max(512).optional(),
  color: hexColor.optional(),
  glow: z.enum(["off", "solid", "breathing"]).optional(),
  /** Static display content (text or markdown) shown on the keycap face. */
  content: z.string().max(4096).optional(),
  contentType: z.enum(["text", "markdown"]).optional(),
  /** Tile span in grid columns/rows (default 1×1). */
  w: z.number().int().min(1).max(4).optional(),
  h: z.number().int().min(1).max(4).optional(),
  /** Omitted for pure display tiles — pressing them is a no-op. */
  action: z
    .discriminatedUnion("type", [
      shortcutActionSchema,
      scriptActionSchema,
      textActionSchema,
      promptActionSchema,
      toggleActionSchema,
    ])
    .optional(),
});

const gridSchema = z.object({
  rows: z.number().int().min(1).max(12),
  cols: z.number().int().min(1).max(12),
});

const buttonsSchema = z
  .array(buttonSchema)
  .max(144)
  .refine((arr) => new Set(arr.map((b) => b.id)).size === arr.length, {
    message: "button ids must be unique",
  });

const profileSchema = z.object({
  /** Stable id used in state.json, RPC calls and focus matching. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only")
    .max(32),
  name: z.string().min(1).max(32),
  /** Tab icon: emoji, fa:name, or short text — same forms as button icons. */
  icon: z.string().max(512).optional(),
  /**
   * Foreground-app auto-switching: when the focused window's app id
   * (wm_class / app_id) contains any of these strings (case-insensitive),
   * this profile activates.
   */
  match: z.object({ apps: z.array(z.string().min(1).max(64)).max(32) }).optional(),
  grid: gridSchema,
  buttons: buttonsSchema,
});

const focusSchema = z.object({
  /** Poll interval for the foreground-app watcher. */
  pollMs: z.number().int().min(250).max(10_000).default(1000),
  /**
   * Custom poll command: must print the focused app's id on stdout.
   * Overrides auto-detection (swaymsg / hyprctl / xdotool) — the escape
   * hatch for compositors without a simple CLI (e.g. GNOME Wayland).
   */
  command: z.string().min(1).max(512).optional(),
});

const configSchema = z
  .object({
    grid: gridSchema.optional(),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(8787),
        /**
         * "lan" (default): reachable from other devices on the local network
         * (e.g. your phone). "local": bind 127.0.0.1 only — this machine only.
         * Either way, authToken is mandatory (config or MACRO_PAD_TOKEN env).
         */
        bind: z.enum(["lan", "local"]).default("lan"),
        shortcutBackend: z.enum(["auto", "nutjs", "xdotool", "ydotool", "noop"]).default("auto"),
        /**
         * The passcode (min 8 chars) — the server executes shell commands and
         * must never run unauthenticated. May be supplied via the
         * MACRO_PAD_TOKEN environment variable instead. The empty string is a
         * sentinel: at startup the server asks for a passcode on the terminal
         * (or generates one when non-interactive) and saves it here.
         */
        authToken: z
          .string()
          .min(8, "authToken must be at least 8 characters")
          .or(z.literal(""))
          .optional(),
        focus: focusSchema.optional(),
      })
      .default({ port: 8787, bind: "lan", shortcutBackend: "auto" }),
    buttons: buttonsSchema.optional(),
    /**
     * Optional multi-profile layout. When present, top-level grid/buttons
     * must be removed (they become per-profile). When absent, the top-level
     * grid/buttons form an implicit single "default" profile.
     */
    profiles: z.array(profileSchema).min(1).max(24).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.profiles) {
      if (c.grid !== undefined || c.buttons !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'when "profiles" is used, top-level "grid" and "buttons" must be removed (move them into a profile)',
        });
      }
      if (new Set(c.profiles.map((p) => p.id)).size !== c.profiles.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["profiles"], message: "profile ids must be unique" });
      }
    } else if (!c.grid || !c.buttons) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'either "profiles" or top-level "grid" + "buttons" are required',
      });
    }
  });

export type StatePatch = z.infer<typeof statePatchSchema>;
export type PadConfig = z.infer<typeof configSchema>;
export type ButtonConfig = z.infer<typeof buttonSchema>;
export type ButtonAction = NonNullable<ButtonConfig["action"]>;
export type SubAction = z.infer<typeof subActionSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** Id of the implicit profile wrapping legacy single-layout configs. */
export const DEFAULT_PROFILE_ID = "default";

/**
 * Write a file readable only by the owner — pad.json contains the passcode.
 * writeFileSync's mode only applies on creation, so chmod afterwards to
 * tighten permissions on pre-existing files too.
 */
export function writePrivateFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort (exotic filesystems) — the write itself succeeded
  }
}

/* --- First-run bootstrap --------------------------------------------------- */

/** User-level config directory: $XDG_CONFIG_HOME/macro-pad (~/.config/macro-pad). */
export function userConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "macro-pad");
}

/** Fallback starter pad when the showcase example is unavailable: media keys work out of the box with xdotool/ydotool. */
function defaultConfig(authToken: string): Record<string, unknown> {
  const media = (
    id: number,
    label: string,
    icon: string,
    keys: string[],
  ): Record<string, unknown> => ({ id, label, icon, action: { type: "shortcut", keys } });
  return {
    grid: { rows: 2, cols: 3 },
    server: { port: 8787, bind: "lan", shortcutBackend: "auto", authToken },
    buttons: [
      media(0, "Play/Pause", "fa:play", ["play"]),
      media(1, "Previous", "fa:backward-step", ["prev"]),
      media(2, "Next", "fa:forward-step", ["next"]),
      media(3, "Mute", "fa:volume-xmark", ["mute"]),
      media(4, "Vol −", "fa:volume-low", ["voldown"]),
      media(5, "Vol +", "fa:volume-high", ["volup"]),
    ],
  };
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bootstrap config is the showcase example (config/pad.example.json,
 * shipped in the package): it demonstrates every feature — profiles, toggles,
 * scripts, prompts, sequences, markdown tiles — and degrades gracefully when
 * a referenced tool isn't installed. Always written with an EMPTY passcode:
 * the first server start asks for one (or generates one when
 * non-interactive). Falls back to the minimal media-keys pad when the
 * example file is missing or broken.
 */
function starterConfigText(): string {
  try {
    const examplePath = path.resolve(moduleDir, "../../config/pad.example.json");
    const text = fs.readFileSync(examplePath, "utf8");
    const parsed = JSON.parse(text) as { server?: Record<string, unknown> };
    // Never bootstrap with a non-empty (i.e. known, shared) passcode baked in.
    if (parsed.server?.authToken === "") return text.endsWith("\n") ? text : text + "\n";
    parsed.server = { ...(parsed.server ?? {}), authToken: "" };
    return JSON.stringify(parsed, null, 2) + "\n";
  } catch {
    return JSON.stringify(defaultConfig(""), null, 2) + "\n";
  }
}

/**
 * Resolve the config file, creating a starter config when none exists. The
 * starter has an empty passcode — the first server start asks for one (or
 * generates one when non-interactive) and saves it. Search order:
 * $MACRO_PAD_CONFIG, ./config, ../config (repo layouts), then the user config
 * dir. Bootstrap target: the env path when set, ./config when that directory
 * exists (repo checkout), otherwise the user config dir.
 */
export function ensureConfigFile(): { file: string; created: boolean } {
  const candidates = [
    process.env.MACRO_PAD_CONFIG,
    path.resolve(process.cwd(), "config/pad.json"),
    path.resolve(process.cwd(), "../config/pad.json"),
    path.join(userConfigDir(), "pad.json"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) return { file: c, created: false };
  }

  const repoConfigDir = path.resolve(process.cwd(), "config");
  const target =
    process.env.MACRO_PAD_CONFIG ??
    (fs.existsSync(repoConfigDir)
      ? path.join(repoConfigDir, "pad.json")
      : path.join(userConfigDir(), "pad.json"));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  writePrivateFile(target, starterConfigText());
  return { file: target, created: true };
}

/**
 * Normalized profile list. Legacy configs (top-level grid/buttons, no
 * "profiles" key) become a single "default" profile, so all downstream code
 * only ever deals with profiles.
 */
export function profilesOf(c: PadConfig): Profile[] {
  if (c.profiles) return c.profiles;
  // superRefine guarantees grid/buttons are present in the legacy shape.
  return [
    {
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      grid: c.grid!,
      buttons: c.buttons!,
    },
  ];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigValidation {
  ok: boolean;
  /** Present when the text is not valid JSON at all. */
  syntaxError?: string;
  /** Schema issues (empty when ok). */
  issues: ConfigIssue[];
}

/**
 * Validate config text without writing anything — powers live checking in
 * the settings UI via the config.validate RPC. Same JSON + schema checks as
 * ConfigStore.setRaw, but returned as structured data instead of thrown.
 */
export function validateConfigText(text: string): ConfigValidation {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      syntaxError: err instanceof Error ? err.message : String(err),
      issues: [],
    };
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  return { ok: true, issues: [] };
}

export interface ConfigStoreEvents {
  change: (config: PadConfig) => void;
  invalid: (err: unknown) => void;
}

/** Used when the config file is broken at startup: empty pad, default server section. */
export const FALLBACK_CONFIG: PadConfig = {
  grid: { rows: 1, cols: 1 },
  server: { port: 8787, bind: "lan", shortcutBackend: "auto" },
  buttons: [],
};

/**
 * Loads and validates pad.json, then watches it for changes (hot reload).
 * On an invalid reload the previous good config is kept and "invalid" is emitted.
 */
export class ConfigStore extends EventEmitter {
  private config!: PadConfig;
  private debounce?: NodeJS.Timeout;

  constructor(private file: string) {
    super();
  }

  load(): PadConfig {
    const raw = fs.readFileSync(this.file, "utf8");
    this.config = configSchema.parse(JSON.parse(raw));
    return this.config;
  }

  /**
   * Load, but fall back to FALLBACK_CONFIG when the file is missing/invalid,
   * so the server can still start and the settings UI stays reachable to
   * repair the file. Returns true when running on the fallback.
   */
  loadSafe(): boolean {
    try {
      this.load();
      return false;
    } catch (err) {
      console.warn(
        `[config] ${this.file} could not be loaded (${
          err instanceof Error ? err.message.split("\n")[0] : err
        }) — starting in repair mode with an empty pad`,
      );
      this.config = FALLBACK_CONFIG;
      return true;
    }
  }

  get current(): PadConfig {
    return this.config;
  }

  /** Raw file contents, exactly as on disk (may be invalid JSON). */
  getRaw(): string {
    return fs.readFileSync(this.file, "utf8");
  }

  /**
   * Validate and write new config text. Throws a readable Error on invalid
   * JSON or schema mismatch — the file on disk is left untouched in that case.
   * On success the file watcher applies the change and notifies clients.
   */
  setRaw(text: string): PadConfig {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON: ${err instanceof Error ? err.message : err}`);
    }
    const parsed = configSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new Error(`config does not match schema:\n${issues.join("\n")}`);
    }
    writePrivateFile(this.file, text.endsWith("\n") ? text : text + "\n");
    return parsed.data;
  }

  /** Watch the containing directory so atomic-save renames are handled. */
  watch(): void {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    fs.watch(dir, (_event, filename) => {
      if (filename !== base) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reload(), 150);
    });
  }

  private reload(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.config = configSchema.parse(JSON.parse(raw));
      this.emit("change", this.config);
    } catch (err) {
      this.emit("invalid", err);
    }
  }
}
