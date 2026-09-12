import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const serverPort = process.env.MACRO_PAD_PORT ?? "8787";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // CSP-safe registration: an external /registerSW.js script tag — no
      // inline code, so script-src 'self' stays intact.
      injectRegister: "script",
      manifest: {
        id: "/",
        name: "Macro Pad",
        short_name: "Macro Pad",
        description:
          "Virtual macro keyboard — tap buttons on your phone to run shortcuts and scripts on this computer.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#07080c",
        theme_color: "#07080c",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // The FontAwesome-packed bundle is ~2.1 MB — above workbox's 2 MiB
        // default precache limit.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
        navigateFallback: "/index.html",
        // Server endpoints must never resolve to the app shell.
        navigateFallbackDenylist: [/^\/rpc/, /^\/auth/, /^\/health/],
      },
    }),
  ],
  server: {
    host: true,
    proxy: {
      "/rpc": {
        target: `http://127.0.0.1:${serverPort}`,
        ws: true,
      },
      "/auth": {
        target: `http://127.0.0.1:${serverPort}`,
      },
    },
  },
});
