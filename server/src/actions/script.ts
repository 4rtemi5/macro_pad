import { exec } from "node:child_process";
import { statePatchSchema, type StatePatch } from "../config.js";

export interface ScriptActionConfig {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  onSuccess?: StatePatch;
  onError?: StatePatch;
}

export interface ActionResult {
  ok: boolean;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

const MAX_OUTPUT = 4000;
const tail = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s);

/**
 * Run a shell command for a button.
 *
 * Patch order (later wins):
 *   1. onSuccess / onError from the config
 *   2. the last stdout line that parses as a JSON state patch
 *
 * `applyPatch` is expected to merge the patch into the runtime state store,
 * which broadcasts a `button.state` notification to all clients.
 */
export function runScript(
  action: ScriptActionConfig,
  applyPatch: (patch: StatePatch) => void,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ActionResult> {
  return new Promise((resolve) => {
    exec(
      action.command,
      {
        cwd: action.cwd,
        timeout: action.timeoutMs ?? 30_000,
        killSignal: "SIGTERM",
        maxBuffer: 1024 * 1024,
        shell: "/bin/bash",
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error.killed || error.signal));
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        const ok = !error;

        const configured = ok ? action.onSuccess : action.onError;
        if (configured) applyPatch(configured);

        const fromStdout = parseStdoutPatch(stdout);
        if (fromStdout) applyPatch(fromStdout);

        resolve({
          ok,
          exitCode,
          stdout: tail(stdout.trim()) || undefined,
          stderr: tail(stderr.trim()) || undefined,
          error: timedOut ? "timeout" : error ? error.message : undefined,
        });
      },
    );
  });
}

/** Scan stdout bottom-up for the first line that is a valid JSON state patch. */
function parseStdoutPatch(stdout: string): StatePatch | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = statePatchSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // keep scanning upwards
    }
  }
  return null;
}
