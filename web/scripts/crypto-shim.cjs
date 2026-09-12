// Build-time only: Node 18 doesn't expose WebCrypto as the global `crypto`
// in CommonJS modules, but serialize-javascript (a workbox-build dependency
// used by vite-plugin-pwa) expects it. No-op on Node 19+.
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = require("node:crypto").webcrypto;
}
