export type Glow = "off" | "solid" | "breathing";

export interface ButtonView {
  id: number;
  label?: string;
  icon?: string;
  color?: string;
  glow?: Glow;
  /** Display text/markdown taking over the keycap face. */
  content?: string;
  contentType?: "text" | "markdown";
  /** Tile span in grid columns/rows (omitted when 1×1). */
  w?: number;
  h?: number;
  /** Omitted for pure display tiles (no action configured). */
  actionType?: "shortcut" | "script" | "text" | "prompt" | "toggle";
  /** Present for prompt buttons: input hint for the text entry sheet. */
  placeholder?: string;
  /** Toggle buttons only: the latched state. */
  on?: boolean;
}

export interface GridSpec {
  rows: number;
  cols: number;
}

export interface ProfileInfo {
  id: string;
  name: string;
  icon?: string;
}

export interface PadSnapshot {
  profiles: ProfileInfo[];
  activeProfile: string;
  grid: GridSpec;
  buttons: ButtonView[];
}

/** Server -> client `button.state` notification params: the full effective view. */
export type ButtonStateNotification = ButtonView;

/** Server -> client `pad.profile` notification params. */
export interface ProfileNotification {
  activeProfile: string;
  reason: "manual" | "focus" | "config";
}

/* --- Full config model (settings editor) — mirrors config/pad.json -------- */

export interface StatePatch {
  color?: string;
  glow?: Glow;
  label?: string;
  icon?: string;
  content?: string;
  contentType?: "text" | "markdown";
}

export interface ShortcutAction {
  type: "shortcut";
  keys: string[];
  /** Follow-up chords pressed in sequence after the main chord (prefix UIs). */
  then?: string[][];
}

/** Insert text into the focused app: simulated keystrokes or clipboard paste. */
export interface TextAction {
  type: "text";
  text: string;
  method?: "type" | "paste";
}

/** Like text, but the text is entered on the phone at press time. */
export interface PromptAction {
  type: "prompt";
  method?: "type" | "paste";
  placeholder?: string;
}

export interface ScriptAction {
  type: "script";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  onSuccess?: StatePatch;
  onError?: StatePatch;
}

/** Actions allowed as toggle sub-actions (everything except toggle itself). */
export type SubAction = ShortcutAction | ScriptAction | TextAction;

/** Latching toggle: flips a server-side flag, running `on` or `off`. */
export interface ToggleAction {
  type: "toggle";
  on: SubAction;
  off: SubAction;
  onState?: StatePatch;
}

export type ButtonAction = ShortcutAction | ScriptAction | TextAction | PromptAction | ToggleAction;

export interface FullButton {
  id: number;
  label?: string;
  icon?: string;
  color?: string;
  glow?: Glow;
  content?: string;
  contentType?: "text" | "markdown";
  /** Tile span in grid columns/rows (default 1). */
  w?: number;
  h?: number;
  /** Omitted for pure display tiles. */
  action?: ButtonAction;
}

export interface FullProfile {
  id: string;
  name: string;
  icon?: string;
  match?: { apps: string[] };
  grid: { rows: number; cols: number };
  buttons: FullButton[];
}

export interface FullConfig {
  grid?: { rows: number; cols: number };
  server: {
    port: number;
    bind: "lan" | "local";
    shortcutBackend: "auto" | "nutjs" | "xdotool" | "ydotool" | "noop";
    authToken?: string;
    focus?: { pollMs: number; command?: string };
  };
  buttons?: FullButton[];
  profiles?: FullProfile[];
}

/* --- config.validate RPC result ------------------------------------------ */

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigValidation {
  ok: boolean;
  syntaxError?: string;
  issues: ConfigIssue[];
}
