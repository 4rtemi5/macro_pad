/**
 * Minimal type shim for the optional @nut-tree/nut-js dependency.
 * The package is loaded via dynamic import only when the "nutjs" shortcut
 * backend is selected, so it is intentionally not a hard dependency.
 * Install it with: npm install @nut-tree/nut-js -w server
 */
declare module "@nut-tree/nut-js" {
  export const keyboard: {
    pressKey(key: unknown): Promise<void>;
    releaseKey(key: unknown): Promise<void>;
    type(text: string): Promise<void>;
  };
  export const Key: Record<string, unknown>;
}
