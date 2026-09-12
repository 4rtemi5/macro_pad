import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { fas } from "@fortawesome/free-solid-svg-icons";
import { far } from "@fortawesome/free-regular-svg-icons";
import { fab } from "@fortawesome/free-brands-svg-icons";

/**
 * Button icon resolution. The `icon` config field accepts four forms:
 *
 *   "🎙️"                emoji — rendered as-is, with a colored bloom
 *   "fa:microphone"     FontAwesome — fa:/fas: solid, far: regular, fab: brands
 *   "⌘" / "OK"          any other short text — rendered as a hollow,
 *                       backlit (transparent) legend
 *   "/icon.png", "https://…", "data:…" — an image
 */
export type ResolvedIcon =
  | { kind: "fa"; def: IconDefinition }
  | { kind: "emoji"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; src: string };

type Pack = Record<string, IconDefinition>;

function indexPack(pack: Pack): Map<string, IconDefinition> {
  const map = new Map<string, IconDefinition>();
  for (const def of Object.values(pack)) {
    if (def?.iconName) map.set(def.iconName, def);
  }
  return map;
}

const SOLID = indexPack(fas as Pack);
const REGULAR = indexPack(far as Pack);
const BRANDS = indexPack(fab as Pack);

/** fa:microphone, fas:fire, far:bell, fab:github, fa-solid:ghost, … */
const FA_PATTERN = /^fa(?:[-:]?(s|r|b|solid|regular|brands?))?[:]\s*([a-z0-9][a-z0-9-]*)$/i;

function lookupFa(packHint: string | undefined, name: string): IconDefinition | undefined {
  const key = name.toLowerCase();
  const hinted = !packHint || packHint === "s" || packHint.startsWith("s") ? SOLID
    : packHint === "r" || packHint.startsWith("r") ? REGULAR
    : BRANDS;
  // Exact pack first, then fall back so a typo'd prefix still finds the icon.
  return hinted.get(key) ?? SOLID.get(key) ?? REGULAR.get(key) ?? BRANDS.get(key);
}

const EMOJI_PATTERN = /\p{Extended_Pictographic}|️|⃣|‍/u;

function isImageIcon(icon: string): boolean {
  return /^(https?:)?\/\//.test(icon) || icon.startsWith("/") || icon.startsWith("data:");
}

export function resolveIcon(icon: string): ResolvedIcon {
  if (isImageIcon(icon)) return { kind: "image", src: icon };

  const fa = FA_PATTERN.exec(icon);
  if (fa) {
    const def = lookupFa(fa[1], fa[2]);
    if (def) return { kind: "fa", def };
    // Unknown icon name: fall through and show the raw text.
  }

  if (EMOJI_PATTERN.test(icon)) return { kind: "emoji", text: icon };
  return { kind: "text", text: icon };
}
