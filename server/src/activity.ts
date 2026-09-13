/** One executed (or attempted) button action. */
export interface ActivityEntry {
  ts: number; // epoch ms
  profile: string;
  button: number;
  label?: string;
  /** Action type, or "display" for inert tiles. */
  action: string;
  ok: boolean;
  error?: string;
}

const CAPACITY = 100;

/**
 * In-memory ring buffer of recent button executions. Powers the pad.getLog
 * RPC and the pad.activity notification; every entry is also written to the
 * server log (journalctl --user -u macro-pad when running as a service).
 *
 * Privacy: never log user-entered text (prompt/text action content) — the
 * action type and button label are enough context.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];

  record(entry: Omit<ActivityEntry, "ts">): ActivityEntry {
    // Keep entries single-line and bounded — they go to the server log.
    const error = entry.error?.replace(/\s*\n+\s*/g, " — ").slice(0, 300);
    const full: ActivityEntry = { ts: Date.now(), ...entry, error };
    this.entries.push(full);
    if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY);
    const status = entry.ok ? "ok" : `FAILED — ${entry.error ?? "error"}`;
    console.log(`[activity] ${entry.profile}/${entry.button} ${entry.action}: ${status}`);
    return full;
  }

  /** Newest first. */
  list(): ActivityEntry[] {
    return [...this.entries].reverse();
  }
}
