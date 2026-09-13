#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureConfigFile } from "./config.js";
import { accessUrl, printAccessInfo } from "./access.js";

const VERSION = "0.1.0";

const USAGE = `macro-pad — virtual macro keyboard server

Usage: macro-pad <command>

Commands:
  start              Start the server (asks for a passcode on first run)
  setup              Create a starter config, print the QR code
  qr                 Print the phone URL + QR code again
  open               Open the pad in this machine's browser
  service install    Install + start a systemd user service (starts at login)
  service uninstall  Stop + remove the systemd user service
  version            Print the version

Environment:
  MACRO_PAD_CONFIG   Path to pad.json (default: ./config, then ~/.config/macro-pad)
  MACRO_PAD_TOKEN    Passcode (overrides the one in pad.json)
`;

/** Read pad.json best-effort and resolve the effective passcode/port/bind. */
function readServerSettings(): { port: number; bind: "lan" | "local"; token: string } {
  const { file } = ensureConfigFile();
  let raw: { server?: { port?: number; bind?: "lan" | "local"; authToken?: string } } = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // fall through to defaults + env token
  }
  return {
    port: raw.server?.port ?? 8787,
    bind: raw.server?.bind ?? "lan",
    token: process.env.MACRO_PAD_TOKEN ?? raw.server?.authToken ?? "",
  };
}

/** Token for commands that print/dial the URL — errors helpfully when unset. */
function requireToken(): { port: number; bind: "lan" | "local"; token: string } {
  const s = readServerSettings();
  if (!s.token) {
    console.error("no passcode set yet — run `macro-pad start` once to choose one");
    process.exit(1);
  }
  return s;
}

function cmdSetup(): void {
  const { file, created } = ensureConfigFile();
  if (created) {
    console.log(`Created a starter config:\n  ${file}\n`);
    console.log("Edit it later in the app's settings page (gear icon) or with your editor.\n");
  } else {
    console.log(`Config already exists:\n  ${file}\n`);
  }
  const { port, bind, token } = readServerSettings();
  if (token) {
    printAccessInfo(port, bind, token);
  } else {
    console.log("The passcode is chosen on the first `macro-pad start` (or set");
    console.log('server.authToken in pad.json yourself), then `macro-pad qr` prints the QR code.');
  }
  console.log("\nNext steps:");
  console.log("  macro-pad start              # run the server");
  console.log("  macro-pad service install    # or start it automatically at login");
}

function cmdQr(): void {
  const { port, bind, token } = requireToken();
  printAccessInfo(port, bind, token);
}

function cmdOpen(): void {
  const { port, bind, token } = requireToken();
  const url = accessUrl(port, bind, token);
  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`open this URL in your browser:\n  ${url}`));
  child.unref();
}

const UNIT = (node: string, cli: string, envLines: string) => `[Unit]
Description=Macro Pad — virtual macro keyboard server
After=network.target

[Service]
${envLines}ExecStart="${node}" "${cli}" start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

function systemctl(...args: string[]): boolean {
  try {
    execSync(`systemctl --user ${args.join(" ")}`, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function cmdService(action: string): void {
  const unitDir = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config"),
    "systemd/user",
  );
  const unitPath = path.join(unitDir, "macro-pad.service");

  if (action === "uninstall") {
    systemctl("disable", "--now", "macro-pad.service");
    fs.rmSync(unitPath, { force: true });
    systemctl("daemon-reload");
    console.log("macro-pad service removed");
    return;
  }
  if (action !== "install") {
    console.error(`unknown service action: ${action} (expected install|uninstall)`);
    process.exit(1);
  }

  // Resolve through npm's bin symlink so the unit survives PATH changes.
  const cli = fs.realpathSync(fileURLToPath(import.meta.url));
  // Keystroke injection needs the session's display environment, which
  // services don't inherit — bake the current one into the unit.
  const displayEnv = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]
    .filter((k) => process.env[k])
    .map((k) => `Environment="${k}=${String(process.env[k]).replace(/"/g, '\\"')}"`)
    .join("\n");
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unitPath, UNIT(process.execPath, cli, displayEnv ? displayEnv + "\n" : ""));
  console.log(`wrote ${unitPath}`);
  if (displayEnv) {
    console.log(`  with session env: ${displayEnv.split("\n").map((l) => l.slice(13, -1)).join(", ")}`);
  }

  if (systemctl("daemon-reload") && systemctl("enable", "--now", "macro-pad.service")) {
    console.log("macro-pad service enabled and started");
    console.log("  logs:    journalctl --user -u macro-pad -f");
    console.log("  headless start at boot (no login): sudo loginctl enable-linger " + (process.env.USER ?? "<you>"));
  } else {
    console.log("systemd --user not available — start manually with: macro-pad start");
    console.log(`or wire up this unit yourself: ${unitPath}`);
  }
  if (!displayEnv) {
    console.log("  note: no DISPLAY/WAYLAND_DISPLAY in this session — if buttons fail with");
    console.log("        'exited with code 1', run: systemctl --user edit macro-pad");
    console.log("        and add under [Service]:  Environment=DISPLAY=:0");
  }
}

async function run(): Promise<void> {
  const cmd = process.argv[2] ?? "start";
  switch (cmd) {
    case "start": {
      const { main } = await import("./index.js");
      await main();
      break;
    }
    case "setup":
      cmdSetup();
      break;
    case "qr":
      cmdQr();
      break;
    case "open":
      cmdOpen();
      break;
    case "service":
      cmdService(process.argv[3] ?? "");
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
