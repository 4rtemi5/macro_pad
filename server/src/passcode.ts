import crypto from "node:crypto";
import fs from "node:fs";
import { writePrivateFile } from "./config.js";

/**
 * First-run passcode setup. An empty `server.authToken` in pad.json means
 * "ask at startup": prompt on the terminal when interactive, generate a
 * random one otherwise, then persist it back into the config file.
 */

/**
 * Hidden-input line reader over raw-mode stdin. readline drains piped input
 * between questions (losing lines) and echoes via a private API that differs
 * across Node versions — this consumes exactly one line per ask, never echoes,
 * and works the same for typed and piped input.
 */
class HiddenLineReader {
  private bytes: number[] = [];
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private skipLf = false;
  private listening = false;

  private onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 0x03) {
        // ctrl-c
        this.close();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 0x0a) continue; // swallow the \n of a \r\n pair
      }
      if (byte === 0x0d) {
        this.skipLf = true;
        this.pushLine();
      } else if (byte === 0x0a) {
        this.pushLine();
      } else if (byte === 0x7f || byte === 0x08) {
        // backspace: drop a whole UTF-8 sequence, not a single byte
        do {
          this.bytes.pop();
        } while (this.bytes.length > 0 && (this.bytes[this.bytes.length - 1] & 0xc0) === 0x80);
      } else if (byte >= 0x20) {
        this.bytes.push(byte);
      }
    }
  };

  private onEnd = () => {
    if (this.waiters.length > 0) {
      console.error("\npasscode prompt aborted (stdin closed)");
      process.exit(1);
    }
  };

  private pushLine() {
    const line = Buffer.from(this.bytes).toString("utf8");
    this.bytes = [];
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.lines.push(line);
  }

  private start() {
    if (this.listening) return;
    this.listening = true;
    const stdin = process.stdin;
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", this.onData);
    stdin.on("end", this.onEnd);
  }

  close() {
    if (!this.listening) return;
    this.listening = false;
    const stdin = process.stdin;
    stdin.off("data", this.onData);
    stdin.off("end", this.onEnd);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
    stdin.pause();
  }

  /** Print the query, resolve with the next line (no echo). */
  ask(query: string): Promise<string> {
    this.start();
    process.stdout.write(query);
    const queued = this.lines.shift();
    if (queued !== undefined) {
      process.stdout.write("\n");
      return Promise.resolve(queued);
    }
    return new Promise((resolve) =>
      this.waiters.push((line) => {
        process.stdout.write("\n");
        resolve(line);
      }),
    );
  }
}

/** Ask for a passcode with hidden echo, confirmed, min 8 chars. */
async function promptPasscode(): Promise<string> {
  const reader = new HiddenLineReader();
  try {
    for (;;) {
      const first = (await reader.ask("Choose a passcode (min 8 characters): ")).trim();
      if (first.length < 8) {
        console.log("Too short — need at least 8 characters.");
        continue;
      }
      const second = (await reader.ask("Confirm passcode: ")).trim();
      if (first !== second) {
        console.log("Passcodes don't match — try again.");
        continue;
      }
      return first;
    }
  } finally {
    reader.close();
  }
}

/**
 * Resolve an empty authToken at startup: ask interactively when a terminal is
 * attached, otherwise generate one; save it into the config file so following
 * starts (and `macro-pad qr`) can use it. Returns the passcode to run with.
 */
export async function setupPasscode(configFile: string): Promise<string> {
  let token: string;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    console.log("No passcode set yet. The pad executes shell commands, so it needs one.");
    token = await promptPasscode();
  } else {
    token = crypto.randomBytes(24).toString("hex");
    console.warn("[auth] no passcode set and no terminal to ask — generated a random one:");
    console.warn(`[auth]   ${token}`);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    raw.server = { ...((raw.server as Record<string, unknown> | undefined) ?? {}), authToken: token };
    writePrivateFile(configFile, JSON.stringify(raw, null, 2) + "\n");
    console.log(`[auth] passcode saved to ${configFile}`);
  } catch (err) {
    console.warn(
      `[auth] could not save the passcode to ${configFile} (${err instanceof Error ? err.message : err}) — ` +
        "it applies to this session only",
    );
  }
  return token;
}
