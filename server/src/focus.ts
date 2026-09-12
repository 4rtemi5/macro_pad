import { spawn, spawnSync } from "node:child_process";

/**
 * Foreground-app watcher: polls the focused window's app id and reports
 * changes. Used to auto-activate profiles whose `match.apps` list matches.
 *
 * Detector auto-detection order:
 *   1. server.focus.command (custom — the escape hatch for compositors
 *      without a simple CLI, e.g. GNOME Wayland)
 *   2. swaymsg  (Sway / wlroots)
 *   3. hyprctl  (Hyprland)
 *   4. xdotool  (X11; on Wayland only sees XWayland windows)
 */

interface Detector {
  name: string;
  command: string;
  args: string[];
  /** Run through bash (custom commands with pipes etc.). */
  shell?: boolean;
  /** Extract the lowercase app id from stdout. */
  parse: (stdout: string) => string | null;
}

function hasBinary(bin: string): boolean {
  const r = spawnSync("which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

interface SwayNode {
  focused?: boolean;
  app_id?: string | null;
  window_properties?: { class?: string; instance?: string };
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

function findFocused(node: SwayNode): SwayNode | null {
  if (node.focused) return node;
  for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
    const found = findFocused(child);
    if (found) return found;
  }
  return null;
}

const firstLineLower = (out: string): string | null =>
  out.trim().split("\n")[0]?.trim().toLowerCase() || null;

export function detectFocusDetector(customCommand?: string): Detector | null {
  if (customCommand) {
    return { name: "custom command", command: customCommand, args: [], shell: true, parse: firstLineLower };
  }
  if (hasBinary("swaymsg")) {
    return {
      name: "swaymsg",
      command: "swaymsg",
      args: ["-t", "get_tree"],
      parse: (out) => {
        const focused = findFocused(JSON.parse(out) as SwayNode);
        const id =
          focused?.app_id ??
          focused?.window_properties?.class ??
          focused?.window_properties?.instance;
        return id ? id.toLowerCase() : null;
      },
    };
  }
  if (hasBinary("hyprctl")) {
    return {
      name: "hyprctl",
      command: "hyprctl",
      args: ["activewindow", "-j"],
      parse: (out) => {
        const w = JSON.parse(out) as { class?: string };
        return w.class ? w.class.toLowerCase() : null;
      },
    };
  }
  if (hasBinary("xdotool")) {
    return {
      name: "xdotool",
      command: "xdotool",
      args: ["getactivewindow", "getwindowclassname"],
      parse: firstLineLower,
    };
  }
  return null;
}

export interface FocusWatcherOptions {
  /** Current poll interval + optional custom command (re-read every tick, so config reloads apply). */
  getOptions: () => { pollMs: number; command?: string };
  /** Whether any profile currently has match.apps — the watcher idles otherwise. */
  hasMatches: () => boolean;
  /** Called when the focused app id changes. */
  onAppChange: (appId: string) => void;
}

export class FocusWatcher {
  private timer?: NodeJS.Timeout;
  private detector: Detector | null = null;
  private detectorKey: string | null = null;
  private lastApp: string | null = null;
  private probing = false;

  constructor(private opts: FocusWatcherOptions) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Detector name for pad.info ("off" when none is available). */
  get detectorName(): string {
    return this.detector?.name ?? "off";
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.opts.getOptions().pollMs);
  }

  private resolveDetector(): Detector | null {
    const key = this.opts.getOptions().command ?? "";
    if (this.detector && this.detectorKey === key) return this.detector;
    this.detector = detectFocusDetector(this.opts.getOptions().command);
    this.detectorKey = key;
    if (this.detector) {
      console.log(`[focus] foreground-app watcher using ${this.detector.name}`);
    } else {
      console.warn(
        "[focus] no foreground-app detector found (install swaymsg/hyprctl/xdotool or set server.focus.command) — profile auto-switching disabled",
      );
    }
    return this.detector;
  }

  private async tick(): Promise<void> {
    try {
      if (!this.opts.hasMatches()) return;
      const detector = this.resolveDetector();
      if (!detector || this.probing) return;
      this.probing = true;
      const app = await this.probe(detector).catch(() => null);
      this.probing = false;
      if (app && app !== this.lastApp) {
        this.lastApp = app;
        this.opts.onAppChange(app);
      }
    } finally {
      this.schedule();
    }
  }

  private probe(det: Detector): Promise<string | null> {
    return new Promise((resolve) => {
      const child = det.shell
        ? spawn(det.command, { shell: "/bin/bash", stdio: ["ignore", "pipe", "ignore"] })
        : spawn(det.command, det.args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const guard = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 5000);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => {
        clearTimeout(guard);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(guard);
        if (code !== 0) return resolve(null);
        try {
          resolve(det.parse(out));
        } catch {
          resolve(null);
        }
      });
    });
  }
}
