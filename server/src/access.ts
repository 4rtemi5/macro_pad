import os from "node:os";
import qrcode from "qrcode-terminal";

/** First non-internal IPv4 address — what a phone on the same LAN can reach. */
export function lanAddress(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** The URL that opens the pad already authenticated (contains the passcode). */
export function accessUrl(port: number, bind: "lan" | "local", token: string): string {
  const host = bind === "lan" ? lanAddress() ?? "127.0.0.1" : "127.0.0.1";
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

/**
 * Print where to open the pad, plus a QR code (encoding the authenticated
 * URL) when the server is LAN-reachable — scan with a phone, no typing.
 */
export function printAccessInfo(port: number, bind: "lan" | "local", token: string): void {
  const url = accessUrl(port, bind, token);
  console.log(`  this machine:  http://127.0.0.1:${port}`);
  if (bind === "lan") {
    console.log(`  phone (LAN):   ${url}`);
    console.log("  scan to open (the QR code / URL contains your passcode — keep it private):");
    qrcode.generate(url, { small: true });
  } else {
    console.log(`  local only:    ${url}`);
  }
}
