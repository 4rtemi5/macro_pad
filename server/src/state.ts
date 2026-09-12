import fs from "node:fs";
import { EventEmitter } from "node:events";
import {
  profilesOf,
  type ButtonConfig,
  type ConfigStore,
  type Profile,
  type StatePatch,
} from "./config.js";

/** What clients see: config values merged with runtime patches and toggle state. */
export interface ButtonView {
  id: number;
  label?: string;
  icon?: string;
  color?: string;
  glow?: "off" | "solid" | "breathing";
  /** Display text/markdown taking over the keycap face. */
  content?: string;
  contentType?: "text" | "markdown";
  /** Tile span in grid columns/rows (omitted when 1×1). */
  w?: number;
  h?: number;
  /** Omitted for pure display tiles (no action configured). */
  actionType?: "shortcut" | "script" | "text" | "prompt" | "toggle";
  /** Present for prompt buttons: input hint for the client's text entry. */
  placeholder?: string;
  /** Present for toggle buttons: the latched state. */
  on?: boolean;
}

export interface ProfileInfo {
  id: string;
  name: string;
  icon?: string;
}

export interface PadSnapshot {
  profiles: ProfileInfo[];
  activeProfile: string;
  grid: Profile["grid"];
  buttons: ButtonView[];
}

/**
 * Runtime button state ("thread" state in Work Louder terms), keyed
 * "<profileId>:<buttonId>" so profiles may reuse button ids.
 *
 * Two layers with different lifetimes:
 *  - patches (color/glow/label/icon set by scripts or button.setState):
 *    cosmetic, cleared when the config reloads.
 *  - toggles (on/off for toggle buttons): survive config reloads AND server
 *    restarts — persisted to state.json next to pad.json (debounced, atomic).
 *
 * Emits "update" (profileId, ButtonView) whenever a button's effective view
 * changes; the server broadcasts it as a `button.state` notification.
 */
export class StateStore extends EventEmitter {
  private patches = new Map<string, StatePatch>();
  private toggles = new Map<string, true>();
  private persistTimer?: NodeJS.Timeout;

  constructor(
    private configs: ConfigStore,
    private stateFile?: string,
  ) {
    super();
    configs.on("change", () => {
      this.patches.clear();
      this.pruneToggles();
    });
  }

  /** Best-effort restore of persisted toggle states at startup. */
  loadToggles(): void {
    if (!this.stateFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as {
        toggles?: Record<string, unknown>;
      };
      for (const [key, value] of Object.entries(raw.toggles ?? {})) {
        if (value === true) this.toggles.set(key, true);
      }
      this.pruneToggles();
      if (this.toggles.size > 0) {
        console.log(`[state] restored ${this.toggles.size} persisted toggle(s)`);
      }
    } catch {
      // missing or broken state file — start clean
    }
  }

  private persistToggles(): void {
    if (!this.stateFile) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const data = JSON.stringify({ toggles: Object.fromEntries(this.toggles) }, null, 2) + "\n";
      const tmp = `${this.stateFile}.tmp`;
      try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, this.stateFile!);
      } catch (err) {
        console.warn(`[state] could not persist toggles: ${err instanceof Error ? err.message : err}`);
      }
    }, 300);
  }

  /** Drop toggle entries whose button no longer exists or is no longer a toggle. */
  private pruneToggles(): void {
    const profiles = profilesOf(this.configs.current);
    for (const key of [...this.toggles.keys()]) {
      const [profileId, idStr] = key.split(":");
      const button = profiles
        .find((p) => p.id === profileId)
        ?.buttons.find((b) => b.id === Number(idStr));
      if (!button || button.action?.type !== "toggle") this.toggles.delete(key);
    }
  }

  snapshot(profileId: string): PadSnapshot {
    const profiles = profilesOf(this.configs.current);
    const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
    return {
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, ...(p.icon ? { icon: p.icon } : {}) })),
      activeProfile: profile.id,
      grid: profile.grid,
      // Config array order is the pad layout order — reordering buttons in
      // settings just reorders the array; ids (used by scripts) stay put.
      buttons: profile.buttons.map((b) => this.view(profile.id, b)),
    };
  }

  /** Apply a runtime patch. Returns false if no button with that id exists in the profile. */
  patch(profileId: string, id: number, patch: StatePatch): boolean {
    const button = this.findButton(profileId, id);
    if (!button) return false;
    const key = `${profileId}:${id}`;
    this.patches.set(key, { ...this.patches.get(key), ...patch });
    this.emit("update", profileId, this.view(profileId, button));
    return true;
  }

  isOn(profileId: string, id: number): boolean {
    return this.toggles.get(`${profileId}:${id}`) === true;
  }

  /** Latch a toggle on/off, persist (debounced) and broadcast the new view. */
  setToggle(profileId: string, id: number, on: boolean): void {
    const button = this.findButton(profileId, id);
    if (!button || button.action?.type !== "toggle") return;
    const key = `${profileId}:${id}`;
    if (on) this.toggles.set(key, true);
    else this.toggles.delete(key);
    this.persistToggles();
    this.emit("update", profileId, this.view(profileId, button));
  }

  private findButton(profileId: string, id: number): ButtonConfig | undefined {
    return profilesOf(this.configs.current)
      .find((p) => p.id === profileId)
      ?.buttons.find((b) => b.id === id);
  }

  private view(profileId: string, b: ButtonConfig): ButtonView {
    const patch = this.patches.get(`${profileId}:${b.id}`) ?? {};
    const action = b.action;
    const on = action?.type === "toggle" ? this.isOn(profileId, b.id) : undefined;
    // Precedence: explicit runtime patch > toggle onState > static config.
    const onState: StatePatch =
      action?.type === "toggle" && on ? action.onState ?? { glow: "solid" } : {};
    return {
      id: b.id,
      label: patch.label ?? onState.label ?? b.label,
      icon: patch.icon ?? onState.icon ?? b.icon,
      color: patch.color ?? onState.color ?? b.color,
      glow: patch.glow ?? onState.glow ?? b.glow,
      content: patch.content ?? onState.content ?? b.content,
      contentType: patch.contentType ?? onState.contentType ?? b.contentType,
      ...(b.w && b.w > 1 ? { w: b.w } : {}),
      ...(b.h && b.h > 1 ? { h: b.h } : {}),
      ...(action ? { actionType: action.type } : {}),
      ...(action?.type === "prompt" && action.placeholder ? { placeholder: action.placeholder } : {}),
      ...(on !== undefined ? { on } : {}),
    };
  }
}
