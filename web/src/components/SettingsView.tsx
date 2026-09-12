import { useEffect, useState, createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGripVertical } from "@fortawesome/free-solid-svg-icons";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RpcClient } from "../rpcClient";
import { resolveIcon } from "../icons";
import { JsonEditor } from "./JsonEditor";
import { KeepAwakeToggle } from "./KeepAwakeToggle";
import type {
  ConfigValidation,
  FullButton,
  FullConfig,
  FullProfile,
  Glow,
  PromptAction,
  ScriptAction,
  ShortcutAction,
  SubAction,
  TextAction,
} from "../types";

interface Props {
  client: RpcClient;
  onClose: () => void;
}

type Mode = "visual" | "json";

const GLOWS: Glow[] = ["off", "solid", "breathing"];
const BACKENDS = ["auto", "nutjs", "xdotool", "ydotool", "noop"] as const;

function tryParse(text: string): FullConfig | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !j.server) return null;
    const legacy = j.grid && Array.isArray(j.buttons);
    const profs = Array.isArray(j.profiles) && j.profiles.length > 0;
    return legacy || profs ? (j as FullConfig) : null;
  } catch {
    return null;
  }
}

/** Collapsible settings section — collapsed by default, with a one-line
    content summary so the closed state stays glanceable. */
function Section({ title, summary, children }: { title: ReactNode; summary: string; children: ReactNode }) {
  return (
    <details className="section">
      <summary>
        <h2>{title}</h2>
        <span className="section-summary">{summary}</span>
        <span className="chevron" aria-hidden="true">
          ▸
        </span>
      </summary>
      {children}
    </details>
  );
}

/** Miniature button icon for collapsed card headers. */
function CardIcon({ icon }: { icon?: string }) {
  if (!icon) return null;
  const r = resolveIcon(icon);
  if (r.kind === "fa") return <FontAwesomeIcon icon={r.def} className="card-icon" />;
  if (r.kind === "image") return <img className="card-icon" src={r.src} alt="" />;
  return <span className="card-icon">{r.text}</span>;
}

/** Display form of a shortcut's chords: "ctrl, b; c" — commas join keys
    within a chord, semicolons separate sequential chords. */
function chordsText(keys: string[], then?: string[][]): string {
  return [keys, ...(then ?? [])].map((chord) => chord.join(", ")).join("; ");
}

/** Drag-handle props of the enclosing SortableCard (context keeps the big
    card JSX inline instead of forcing a full component extraction). */
const DragHandleCtx = createContext<HTMLAttributes<HTMLElement>>({});

/** A button card that can be reordered by dragging its grip handle. */
function SortableCard({ id, children }: { id: number; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <details
      ref={setNodeRef}
      className={`button-card${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <DragHandleCtx.Provider value={{ ...attributes, ...listeners }}>{children}</DragHandleCtx.Provider>
    </details>
  );
}

/** Grip handle for a card's summary row. */
function DragHandle({ label }: { label: string }) {
  const props = useContext(DragHandleCtx);
  return (
    <span
      className="drag-handle"
      {...props}
      // Tapping the grip must not toggle the card open/closed.
      onClick={(e) => e.preventDefault()}
      aria-label={label}
    >
      <FontAwesomeIcon icon={faGripVertical} />
    </span>
  );
}

export function SettingsView({ client, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("visual");
  const [text, setText] = useState("");
  const [cfg, setCfg] = useState<FullConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editProfileIdx, setEditProfileIdx] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [movedPort, setMovedPort] = useState<number | null>(null);
  const [validation, setValidation] = useState<ConfigValidation | null>(null);

  // Live schema checking while in JSON mode (debounced; server-side zod is
  // the single source of truth). Syntax errors are additionally underlined
  // inline by the editor's own linter.
  useEffect(() => {
    if (mode !== "json" || loadError) {
      setValidation(null);
      return;
    }
    const t = setTimeout(() => {
      client
        .call<ConfigValidation>("config.validate", { text })
        .then(setValidation)
        .catch(() => setValidation(null)); // connection trouble — don't block editing
    }, 400);
    return () => clearTimeout(t);
  }, [text, mode, loadError, client]);

  const load = () => {
    setLoadError(null);
    setSaveError(null);
    client
      .call<{ text: string }>("config.getRaw")
      .then(({ text }) => {
        setText(text);
        const parsed = tryParse(text);
        setCfg(parsed);
        setDrafts({});
        setEditProfileIdx(0);
        if (parsed) {
          setMode("visual");
          setNotice(null);
        } else {
          // The file on disk is broken — JSON mode stays reachable to fix it.
          setMode("json");
          setNotice("The config file is not valid JSON — fix it below in JSON mode.");
        }
      })
      .catch((e: Error) => setLoadError(e.message));
  };

  // load once on mount
  useEffect(load, []);

  const switchMode = (to: Mode) => {
    if (to === mode) return;
    setSaveError(null);
    if (to === "json") {
      if (cfg) {
        try {
          setText(buildFromVisual(cfg));
        } catch (e) {
          setSaveError((e as Error).message);
          return;
        }
      }
      setMode("json");
    } else {
      const parsed = tryParse(text);
      if (!parsed) {
        setSaveError("The JSON is currently invalid — fix it before switching to visual mode.");
        return;
      }
      setCfg(parsed);
      setDrafts({});
      setEditProfileIdx(0);
      setMode("visual");
    }
  };

  /* --- profile-aware model access -----------------------------------------
     The Grid/Buttons sections always edit one profile: the selected one for
     multi-profile configs, or the implicit top-level layout for legacy ones. */

  /** Index of the edited profile, or -1 for legacy top-level grid/buttons. */
  const profileIdx = (c: FullConfig): number =>
    c.profiles ? Math.min(editProfileIdx, c.profiles.length - 1) : -1;

  const profileOf = (c: FullConfig): FullProfile => {
    const i = profileIdx(c);
    if (i >= 0) return c.profiles![i];
    return {
      id: "default",
      name: "Default",
      grid: c.grid ?? { rows: 1, cols: 1 },
      buttons: c.buttons ?? [],
    };
  };

  /** Draft-key prefix so free-text fields don't collide across profiles. */
  const draftPrefix = (c: FullConfig): string => {
    const i = profileIdx(c);
    return i >= 0 ? `p${i}:` : "";
  };

  /** Serialize the visual model, applying free-text drafts (keys, patches). */
  const buildFromVisual = (c: FullConfig): string => {
    const buildButton = (b: FullButton, prefix: string, i: number): Record<string, unknown> => {
      const out: Record<string, unknown> = { id: b.id };
      if (b.label) out.label = b.label;
      if (b.icon) out.icon = b.icon;
      if (b.color) out.color = b.color;
      if (b.glow) out.glow = b.glow;
      if (b.content) out.content = b.content;
      if (b.content && b.contentType && b.contentType !== "text") out.contentType = b.contentType;
      if (b.w && b.w > 1) out.w = b.w;
      if (b.h && b.h > 1) out.h = b.h;

      const buildShortcut = (a: ShortcutAction, draftKey: string) => {
        // "ctrl, b; c" — commas separate keys within a chord, semicolons
        // start a new chord pressed after the previous one is released.
        const groups = (drafts[draftKey] ?? chordsText(a.keys, a.then))
          .split(";")
          .map((g) =>
            g
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean),
          )
          .filter((g) => g.length > 0);
        const o: Record<string, unknown> = { type: "shortcut", keys: groups[0] ?? [] };
        if (groups.length > 1) o.then = groups.slice(1);
        return o;
      };
      const buildScript = (a: ScriptAction) => {
        const o: Record<string, unknown> = { type: "script", command: a.command };
        if (a.cwd) o.cwd = a.cwd;
        if (a.timeoutMs) o.timeoutMs = a.timeoutMs;
        for (const field of ["onSuccess", "onError"] as const) {
          const draft = drafts[`${prefix}${i}:${field}`];
          const existing = a[field];
          if (draft === undefined) {
            if (existing) o[field] = existing;
          } else if (!draft.trim()) {
            // cleared — omit
          } else {
            try {
              o[field] = JSON.parse(draft);
            } catch {
              throw new Error(`button ${b.id}: ${field} is not valid JSON`);
            }
          }
        }
        return o;
      };
      const buildText = (a: TextAction) => {
        const o: Record<string, unknown> = { type: "text", text: a.text };
        if (a.method && a.method !== "type") o.method = a.method;
        return o;
      };
      const buildPrompt = (a: PromptAction) => {
        const o: Record<string, unknown> = { type: "prompt" };
        if (a.method && a.method !== "type") o.method = a.method;
        if (a.placeholder) o.placeholder = a.placeholder;
        return o;
      };
      const buildSub = (a: SubAction, draftKey: string): Record<string, unknown> =>
        a.type === "shortcut" ? buildShortcut(a, draftKey) : a.type === "text" ? buildText(a) : buildScript(a);

      if (!b.action) {
        // pure display tile — no action key
      } else if (b.action.type === "toggle") {
        const t = b.action;
        const action: Record<string, unknown> = {
          type: "toggle",
          on: buildSub(t.on, `${prefix}${i}:on.keys`),
          off: buildSub(t.off, `${prefix}${i}:off.keys`),
        };
        if (t.onState) action.onState = t.onState;
        out.action = action;
      } else if (b.action.type === "prompt") {
        out.action = buildPrompt(b.action);
      } else {
        out.action = buildSub(b.action, `${prefix}${i}:keys`);
      }
      return out;
    };

    const server: Record<string, unknown> = {
      port: c.server.port,
      bind: c.server.bind,
      shortcutBackend: c.server.shortcutBackend,
    };
    // Empty string is kept on purpose: it's the "ask on next start" sentinel.
    if (c.server.authToken !== undefined) server.authToken = c.server.authToken;
    if (c.server.focus) {
      const f: Record<string, unknown> = {};
      if (c.server.focus.pollMs && c.server.focus.pollMs !== 1000) f.pollMs = c.server.focus.pollMs;
      if (c.server.focus.command) f.command = c.server.focus.command;
      if (Object.keys(f).length > 0) server.focus = f;
    }

    if (c.profiles) {
      const profiles = c.profiles.map((p, pi) => {
        const out: Record<string, unknown> = { id: p.id, name: p.name };
        if (p.icon) out.icon = p.icon;
        const apps = (drafts[`profile:${pi}:apps`] ?? (p.match?.apps ?? []).join(", "))
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        if (apps.length > 0) out.match = { apps };
        out.grid = p.grid;
        out.buttons = p.buttons.map((b, i) => buildButton(b, `p${pi}:`, i));
        return out;
      });
      return JSON.stringify({ server, profiles }, null, 2);
    }
    return JSON.stringify(
      { grid: c.grid, server, buttons: (c.buttons ?? []).map((b, i) => buildButton(b, "", i)) },
      null,
      2,
    );
  };

  const save = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const textOut = mode === "json" ? text : buildFromVisual(cfg!);
      await client.call("config.setRaw", { text: textOut });
      // The server applies port/bind changes live. If the port changed, this
      // connection is about to die — follow the server to its new address.
      const newPort = mode === "json" ? tryParse(text)?.server?.port : cfg?.server.port;
      const currentPort = Number(location.port) || (location.protocol === "https:" ? 443 : 80);
      if (newPort && newPort !== currentPort) {
        setMovedPort(newPort);
        setTimeout(() => {
          location.port = String(newPort);
        }, 2000);
        return;
      }
      onClose(); // the pad.config notification refreshes the pad behind us
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /* --- visual model updaters ---------------------------------------------- */

  /** Run fn against the edited profile (or the legacy top-level layout). */
  const updateProfileAt = (fn: (p: FullProfile) => FullProfile) =>
    setCfg((c) => {
      if (!c) return c;
      const i = profileIdx(c);
      if (i >= 0) {
        return { ...c, profiles: c.profiles!.map((p, j) => (j === i ? fn(p) : p)) };
      }
      const next = fn(profileOf(c));
      return { ...c, grid: next.grid, buttons: next.buttons };
    });

  const updateButton = (i: number, patch: Partial<FullButton>) =>
    updateProfileAt((p) => ({
      ...p,
      buttons: p.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)),
    }));

  const updateAction = (i: number, patch: Record<string, unknown>) =>
    updateProfileAt((p) => ({
      ...p,
      buttons: p.buttons.map((b, j) =>
        j === i ? { ...b, action: { ...b.action, ...patch } as FullButton["action"] } : b,
      ),
    }));

  const setActionType = (i: number, type: "none" | "shortcut" | "script" | "text" | "prompt" | "toggle") => {
    updateButton(i, {
      action:
        type === "none"
          ? undefined // pure display tile
          : type === "shortcut"
            ? { type, keys: ["f13"] }
            : type === "text"
              ? { type, text: "Hello, clipboard!" }
              : type === "prompt"
                ? { type, placeholder: "Type on your phone…" }
                : type === "script"
                  ? { type, command: "echo '{\"glow\":\"breathing\",\"color\":\"#00c853\"}'" }
                  : {
                      type,
                      on: { type: "shortcut", keys: ["f13"] },
                      off: { type: "shortcut", keys: ["f13"] },
                    },
    });
  };

  /** Toggle sub-action (on/off) updaters. */
  const updateToggleSub = (bi: number, which: "on" | "off", patch: Record<string, unknown>) =>
    updateProfileAt((p) => ({
      ...p,
      buttons: p.buttons.map((b, j) => {
        if (j !== bi || b.action?.type !== "toggle") return b;
        return { ...b, action: { ...b.action, [which]: { ...b.action[which], ...patch } } };
      }),
    }));

  const setToggleSubType = (bi: number, which: "on" | "off", type: SubAction["type"]) =>
    updateProfileAt((p) => ({
      ...p,
      buttons: p.buttons.map((b, j) => {
        if (j !== bi || b.action?.type !== "toggle") return b;
        const sub: SubAction =
          type === "shortcut"
            ? { type, keys: ["f13"] }
            : type === "text"
              ? { type, text: "Hello!" }
              : { type, command: "echo hello" };
        return { ...b, action: { ...b.action, [which]: sub } as FullButton["action"] };
      }),
    }));

  const addButton = () =>
    updateProfileAt((p) => ({
      ...p,
      buttons: [
        ...p.buttons,
        {
          id: p.buttons.reduce((m, b) => Math.max(m, b.id), -1) + 1,
          label: "New",
          color: "#3a3f4b",
          glow: "off",
          action: { type: "shortcut", keys: ["f13"] },
        },
      ],
    }));

  const removeButton = (i: number) =>
    updateProfileAt((p) => ({ ...p, buttons: p.buttons.filter((_, j) => j !== i) }));

  // Drag-and-drop reordering: the array order IS the pad layout order (ids
  // stay attached to their buttons, so script references survive reorders).
  // PointerSensor covers mouse + touch; KeyboardSensor (focus the grip, Space
  // to lift, arrows to move, Space to drop) makes reordering accessible.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorderButtons = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    updateProfileAt((p) => {
      const from = p.buttons.findIndex((b) => b.id === Number(active.id));
      const to = p.buttons.findIndex((b) => b.id === Number(over.id));
      return from < 0 || to < 0 ? p : { ...p, buttons: arrayMove(p.buttons, from, to) };
    });
  };

  /* --- profile management --------------------------------------------------- */

  const convertToProfiles = () =>
    setCfg((c) => {
      if (!c || c.profiles) return c;
      return {
        server: c.server,
        profiles: [
          {
            id: "default",
            name: "Default",
            grid: c.grid ?? { rows: 2, cols: 3 },
            buttons: c.buttons ?? [],
          },
        ],
      };
    });

  const convertToSingle = () =>
    setCfg((c) => {
      if (!c?.profiles) return c;
      const first = c.profiles[0];
      return { grid: first.grid, server: c.server, buttons: first.buttons };
    });

  const addProfile = () =>
    setCfg((c) => {
      if (!c?.profiles) return c;
      let n = c.profiles.length + 1;
      let id = `profile-${n}`;
      while (c.profiles.some((p) => p.id === id)) id = `profile-${++n}`;
      return {
        ...c,
        profiles: [...c.profiles, { id, name: `Profile ${n}`, grid: { rows: 2, cols: 3 }, buttons: [] }],
      };
    });

  const removeProfile = (i: number) =>
    setCfg((c) => {
      if (!c?.profiles || c.profiles.length <= 1) return c;
      return { ...c, profiles: c.profiles.filter((_, j) => j !== i) };
    });

  const updateProfileMeta = (i: number, patch: Partial<FullProfile>) =>
    setCfg((c) =>
      c?.profiles ? { ...c, profiles: c.profiles.map((p, j) => (j === i ? { ...p, ...patch } : p)) } : c,
    );

  const setDraft = (key: string, value: string) =>
    setDrafts((d) => ({ ...d, [key]: value }));

  /* --- render ------------------------------------------------------------ */

  if (movedPort !== null) {
    const target = `${location.protocol}//${location.hostname}:${movedPort}${location.pathname}`;
    return (
      <div className="settings-overlay">
        <div className="settings-inner">
          <div className="moved-notice">
            <h1>Server moved to port {movedPort}</h1>
            <p>Redirecting you there…</p>
            <a href={target}>Tap here if nothing happens</a>
          </div>
        </div>
      </div>
    );
  }

  const profile = cfg ? profileOf(cfg) : null;
  const prefix = cfg ? draftPrefix(cfg) : "";

  return (
    <div className="settings-overlay">
      <div className="settings-inner">
        <header className="settings-header">
          <h1>Settings</h1>
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <section>
          <h2>This device</h2>
          <KeepAwakeToggle />
        </section>

        <div className="mode-toggle">
          <button className={mode === "visual" ? "active" : ""} onClick={() => switchMode("visual")}>
            Visual
          </button>
          <button className={mode === "json" ? "active" : ""} onClick={() => switchMode("json")}>
            JSON
          </button>
        </div>

        {notice && <div className="settings-notice">{notice}</div>}
        {loadError && <div className="settings-error">Could not load config: {loadError}</div>}
        {saveError && <div className="settings-error">{saveError}</div>}

        {mode === "json" && !loadError && (
          <>
            <JsonEditor value={text} onChange={setText} />
            {validation &&
              (validation.ok ? (
                <div className="json-status json-ok">✓ valid — matches the config schema</div>
              ) : (
                <div className="json-status json-bad">
                  {validation.syntaxError ? (
                    <>Syntax error: {validation.syntaxError}</>
                  ) : (
                    <>
                      Schema mismatch:
                      <ul>
                        {validation.issues.map((i, n) => (
                          <li key={n}>
                            <code>{i.path}</code>: {i.message}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}
          </>
        )}

        {mode === "visual" && cfg && profile && (
          <>
            <Section
              title="Profiles"
              summary={
                cfg.profiles
                  ? `${cfg.profiles.length} profile${cfg.profiles.length === 1 ? "" : "s"}`
                  : "single layout"
              }
            >
              {cfg.profiles ? (
                <>
                  {cfg.profiles.map((p, pi) => (
                    <div className="button-card" key={pi}>
                      <div className="form-row">
                        <label className="field-grow">
                          Name
                          <input
                            type="text"
                            value={p.name}
                            onChange={(e) => updateProfileMeta(pi, { name: e.target.value })}
                          />
                        </label>
                        <label>
                          Id
                          <input
                            type="text"
                            spellCheck={false}
                            value={p.id}
                            onChange={(e) =>
                              updateProfileMeta(pi, {
                                id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                              })
                            }
                          />
                        </label>
                        <button
                          className="delete-button"
                          onClick={() => removeProfile(pi)}
                          disabled={cfg.profiles!.length <= 1}
                          aria-label={`Delete profile ${p.name}`}
                        >
                          🗑
                        </button>
                      </div>
                      <div className="form-row">
                        <label className="field-grow">
                          Tab icon (emoji, fa:name, or text)
                          <input
                            type="text"
                            value={p.icon ?? ""}
                            onChange={(e) => updateProfileMeta(pi, { icon: e.target.value || undefined })}
                          />
                        </label>
                      </div>
                      <label className="form-block">
                        Auto-switch apps (comma-separated — matched against the focused window's
                        app id / wm_class)
                        <input
                          type="text"
                          spellCheck={false}
                          placeholder="firefox, code, org.gnome.nautilus"
                          value={drafts[`profile:${pi}:apps`] ?? (p.match?.apps ?? []).join(", ")}
                          onChange={(e) => setDraft(`profile:${pi}:apps`, e.target.value)}
                        />
                      </label>
                    </div>
                  ))}
                  <button className="add-button" onClick={addProfile}>
                    + Add profile
                  </button>
                  {cfg.profiles.length === 1 && (
                    <button className="add-button" onClick={convertToSingle}>
                      Convert back to single layout
                    </button>
                  )}
                  <p className="field-note">
                    Each profile is a tab on the pad with its own grid and buttons. When the
                    focused window matches a profile's app list, the pad switches to it
                    automatically; tapping a tab switches manually. Button ids only need to be
                    unique within a profile.
                  </p>
                </>
              ) : (
                <>
                  <p className="field-note">
                    Single layout — one grid of buttons. Convert to profiles to get tabs and
                    per-app auto-switching; your current grid becomes the first profile.
                  </p>
                  <button className="add-button" onClick={convertToProfiles}>
                    Convert to profiles
                  </button>
                </>
              )}
            </Section>

            {cfg.profiles && cfg.profiles.length > 1 && (
              <div className="form-row profile-picker">
                <label className="field-grow">
                  Editing profile
                  <select
                    value={profileIdx(cfg)}
                    onChange={(e) => setEditProfileIdx(parseInt(e.target.value, 10))}
                  >
                    {cfg.profiles.map((p, pi) => (
                      <option key={pi} value={pi}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <Section
              title={<>Grid{cfg.profiles ? ` — ${profile.name}` : ""}</>}
              summary={`${profile.grid.rows} × ${profile.grid.cols}`}
            >
              <div className="form-row">
                <label>
                  Rows
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={profile.grid.rows || ""}
                    onChange={(e) =>
                      updateProfileAt((p) => ({
                        ...p,
                        grid: { ...p.grid, rows: parseInt(e.target.value, 10) || 0 },
                      }))
                    }
                  />
                </label>
                <label>
                  Columns
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={profile.grid.cols || ""}
                    onChange={(e) =>
                      updateProfileAt((p) => ({
                        ...p,
                        grid: { ...p.grid, cols: parseInt(e.target.value, 10) || 0 },
                      }))
                    }
                  />
                </label>
              </div>
            </Section>

            <Section
              title="Server"
              summary={`:${cfg.server.port} · ${cfg.server.bind} · ${cfg.server.shortcutBackend}`}
            >
              <div className="form-row">
                <label>
                  Port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={cfg.server.port || ""}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        server: { ...cfg.server, port: parseInt(e.target.value, 10) || 0 },
                      })
                    }
                  />
                </label>
                <label>
                  Bind
                  <select
                    value={cfg.server.bind}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        server: { ...cfg.server, bind: e.target.value as "lan" | "local" },
                      })
                    }
                  >
                    <option value="lan">lan (phone reachable)</option>
                    <option value="local">local (this machine only)</option>
                  </select>
                </label>
                <label>
                  Shortcut backend
                  <select
                    value={cfg.server.shortcutBackend}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        server: {
                          ...cfg.server,
                          shortcutBackend: e.target.value as FullConfig["server"]["shortcutBackend"],
                        },
                      })
                    }
                  >
                    {BACKENDS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="form-block">
                Passcode (authToken)
                <input
                  type="text"
                  autoComplete="off"
                  placeholder="min 8 characters (empty = ask on next start)"
                  value={cfg.server.authToken ?? ""}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      server: { ...cfg.server, authToken: e.target.value },
                    })
                  }
                />
              </label>
              <div className="form-row">
                <label>
                  Focus poll (ms)
                  <input
                    type="number"
                    min={250}
                    max={10000}
                    step={250}
                    placeholder="1000"
                    value={cfg.server.focus?.pollMs ?? ""}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setCfg({
                        ...cfg,
                        server: {
                          ...cfg.server,
                          focus: {
                            pollMs: Number.isFinite(v) ? v : 1000,
                            command: cfg.server.focus?.command,
                          },
                        },
                      });
                    }}
                  />
                </label>
                <label className="field-grow">
                  Focus command (optional override)
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="auto-detect swaymsg / hyprctl / xdotool"
                    value={cfg.server.focus?.command ?? ""}
                    onChange={(e) => {
                      const command = e.target.value || undefined;
                      const existing = cfg.server.focus;
                      const focus =
                        command || existing
                          ? { pollMs: existing?.pollMs ?? 1000, command }
                          : undefined;
                      setCfg({ ...cfg, server: { ...cfg.server, focus } });
                    }}
                  />
                </label>
              </div>
              <p className="field-note">
                All of these apply on save — no restart needed. If you change the port, this page
                will redirect to the new address. Focus settings drive profile auto-switching
                (only used when a profile has an app list).
              </p>
            </Section>

            <Section
              title={<>Buttons{cfg.profiles ? ` — ${profile.name}` : ""}</>}
              summary={`${profile.buttons.length} button${profile.buttons.length === 1 ? "" : "s"}`}
            >
              <p className="field-note">
                Drag the grip to reorder — the pad lays out buttons in this order (ids stay the
                same, so script references keep working).
              </p>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderButtons}>
                <SortableContext
                  items={profile.buttons.map((b) => b.id)}
                  strategy={verticalListSortingStrategy}
                >
              {profile.buttons.map((b, i) => (
                <SortableCard key={b.id} id={b.id}>
                  <summary>
                    <DragHandle label={`Reorder button ${b.id}`} />
                    <CardIcon icon={b.icon} />
                    <span className="button-card-title">
                      {b.label?.trim() || `Button ${b.id}`}
                      <span className="button-card-meta">
                        #{b.id} · {b.action?.type ?? "display"}
                        {(b.w ?? 1) > 1 || (b.h ?? 1) > 1 ? ` · ${b.w ?? 1}×${b.h ?? 1}` : ""}
                      </span>
                    </span>
                    <button
                      className="delete-button"
                      onClick={(e) => {
                        // Deleting must not toggle the card open/closed.
                        e.preventDefault();
                        removeButton(i);
                      }}
                      aria-label={`Delete button ${b.id}`}
                    >
                      🗑
                    </button>
                    <span className="chevron" aria-hidden="true">
                      ▸
                    </span>
                  </summary>
                  <div className="form-row">
                    <label className="field-id">
                      Id
                      <input
                        type="number"
                        min={0}
                        max={999}
                        value={b.id}
                        onChange={(e) =>
                          updateButton(i, { id: parseInt(e.target.value, 10) || 0 })
                        }
                      />
                    </label>
                    <label className="field-grow">
                      Label
                      <input
                        type="text"
                        value={b.label ?? ""}
                        onChange={(e) => updateButton(i, { label: e.target.value || undefined })}
                      />
                    </label>
                    <label className="field-span">
                      Span W
                      <input
                        type="number"
                        min={1}
                        max={4}
                        title="Tile width in grid columns"
                        value={b.w ?? 1}
                        onChange={(e) =>
                          updateButton(i, {
                            w: Math.min(4, Math.max(1, parseInt(e.target.value, 10) || 1)),
                          })
                        }
                      />
                    </label>
                    <label className="field-span">
                      Span H
                      <input
                        type="number"
                        min={1}
                        max={4}
                        title="Tile height in grid rows"
                        value={b.h ?? 1}
                        onChange={(e) =>
                          updateButton(i, {
                            h: Math.min(4, Math.max(1, parseInt(e.target.value, 10) || 1)),
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="field-grow">
                      Icon (emoji, fa:name, text, or image URL)
                      <input
                        type="text"
                        value={b.icon ?? ""}
                        onChange={(e) => updateButton(i, { icon: e.target.value || undefined })}
                      />
                    </label>
                    <label>
                      Color
                      <span className="color-field">
                        <input
                          type="color"
                          value={b.color ?? "#4a5160"}
                          onChange={(e) => updateButton(i, { color: e.target.value })}
                        />
                        {b.color && (
                          <button
                            className="clear-color"
                            onClick={() => updateButton(i, { color: undefined })}
                            title="Use default color"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </label>
                    <label>
                      Glow
                      <select
                        value={b.glow ?? "off"}
                        onChange={(e) =>
                          updateButton(i, { glow: e.target.value as Glow })
                        }
                      >
                        {GLOWS.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="field-grow">
                      Content (optional — text/markdown shown on the keycap face)
                      <textarea
                        rows={2}
                        spellCheck={false}
                        placeholder="CPU 42%  or  **bold** notes…"
                        value={b.content ?? ""}
                        onChange={(e) =>
                          updateButton(i, { content: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label>
                      Format
                      <select
                        value={b.contentType ?? "text"}
                        onChange={(e) =>
                          updateButton(i, {
                            contentType: e.target.value === "markdown" ? "markdown" : undefined,
                          })
                        }
                      >
                        <option value="text">text</option>
                        <option value="markdown">markdown</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Action
                      <select
                        value={b.action?.type ?? "none"}
                        onChange={(e) =>
                          setActionType(
                            i,
                            e.target.value as "none" | "shortcut" | "script" | "text" | "prompt" | "toggle",
                          )
                        }
                      >
                        <option value="none">none (display tile)</option>
                        <option value="shortcut">shortcut</option>
                        <option value="script">script</option>
                        <option value="text">text (insert)</option>
                        <option value="prompt">prompt (type on phone)</option>
                        <option value="toggle">toggle (latching)</option>
                      </select>
                    </label>
                  </div>

                  {b.action?.type === "text" && (
                    <>
                      <label className="form-block">
                        Text to insert into the focused app
                        <textarea
                          rows={2}
                          spellCheck={false}
                          value={b.action.text}
                          onChange={(e) => updateAction(i, { text: e.target.value })}
                        />
                      </label>
                      <div className="form-row">
                        <label>
                          Method
                          <select
                            value={b.action.method ?? "type"}
                            onChange={(e) =>
                              updateAction(i, {
                                method: e.target.value === "paste" ? "paste" : undefined,
                              })
                            }
                          >
                            <option value="type">type (keystrokes)</option>
                            <option value="paste">paste (clipboard + ctrl+v)</option>
                          </select>
                        </label>
                      </div>
                      <p className="field-note">
                        Typing simulates keystrokes and leaves the clipboard alone. Paste is
                        instant for long text but overwrites the clipboard and needs{" "}
                        <code>xclip</code> (X11) or <code>wl-copy</code> (Wayland); ctrl+v does
                        not work in every app (e.g. terminals).
                      </p>
                    </>
                  )}

                  {b.action?.type === "prompt" && (
                    <>
                      <div className="form-row">
                        <label>
                          Method
                          <select
                            value={b.action.method ?? "type"}
                            onChange={(e) =>
                              updateAction(i, {
                                method: e.target.value === "paste" ? "paste" : undefined,
                              })
                            }
                          >
                            <option value="type">type (keystrokes)</option>
                            <option value="paste">paste (clipboard + ctrl+v)</option>
                          </select>
                        </label>
                        <label className="field-grow">
                          Placeholder (optional)
                          <input
                            type="text"
                            maxLength={64}
                            placeholder="Type on your phone…"
                            value={b.action.placeholder ?? ""}
                            onChange={(e) =>
                              updateAction(i, { placeholder: e.target.value || undefined })
                            }
                          />
                        </label>
                      </div>
                      <p className="field-note">
                        Tapping this button opens a text field on the phone; whatever you type
                        there is inserted into the focused app, like the text action but with
                        the text decided at tap time.
                      </p>
                    </>
                  )}

                  {b.action?.type === "shortcut" && (
                    <label className="form-block">
                      Keys (comma-separated chord; semicolons start a follow-up chord, e.g.
                      ctrl, b; c)
                      <input
                        type="text"
                        value={drafts[`${prefix}${i}:keys`] ?? chordsText(b.action.keys, b.action.then)}
                        onChange={(e) => setDraft(`${prefix}${i}:keys`, e.target.value)}
                      />
                    </label>
                  )}

                  {b.action?.type === "script" && (
                    <>
                      <label className="form-block">
                        Command (run via bash)
                        <textarea
                          rows={2}
                          spellCheck={false}
                          value={b.action.command}
                          onChange={(e) => updateAction(i, { command: e.target.value })}
                        />
                      </label>
                      <div className="form-row">
                        <label>
                          Timeout (ms)
                          <input
                            type="number"
                            min={100}
                            max={300000}
                            placeholder="30000"
                            value={b.action.timeoutMs ?? ""}
                            onChange={(e) =>
                              updateAction(i, {
                                timeoutMs: parseInt(e.target.value, 10) || undefined,
                              })
                            }
                          />
                        </label>
                        <label className="field-grow">
                          Working directory (optional)
                          <input
                            type="text"
                            value={b.action.cwd ?? ""}
                            onChange={(e) => updateAction(i, { cwd: e.target.value || undefined })}
                          />
                        </label>
                      </div>
                      {(["onSuccess", "onError"] as const).map((field) => {
                        const scriptAction = b.action as ScriptAction;
                        return (
                          <label className="form-block" key={field}>
                            {field} state patch (JSON, optional)
                            <textarea
                              rows={1}
                              spellCheck={false}
                              placeholder='{"color":"#00c853","glow":"solid"}'
                              value={
                                drafts[`${prefix}${i}:${field}`] ??
                                (scriptAction[field] ? JSON.stringify(scriptAction[field]) : "")
                              }
                              onChange={(e) => setDraft(`${prefix}${i}:${field}`, e.target.value)}
                            />
                          </label>
                        );
                      })}
                    </>
                  )}

                  {b.action?.type === "toggle" && (
                    <>
                      <p className="field-note">
                        Latching switch: each press flips the state and runs the matching action.
                        The state survives restarts; while on, the key stays lit and depressed
                        (customize via <code>onState</code> in JSON mode).
                      </p>
                      {(["on", "off"] as const).map((which) => {
                        const action = b.action;
                        if (action?.type !== "toggle") return null;
                        const sub = action[which];
                        return (
                          <div className="toggle-sub" key={which}>
                            <div className="form-row">
                              <label>
                                When switched {which}
                                <select
                                  value={sub.type}
                                  onChange={(e) =>
                                    setToggleSubType(i, which, e.target.value as SubAction["type"])
                                  }
                                >
                                  <option value="shortcut">shortcut</option>
                                  <option value="script">script</option>
                                  <option value="text">text</option>
                                </select>
                              </label>
                            </div>
                            {sub.type === "shortcut" ? (
                              <label className="form-block">
                                Keys (comma-separated; semicolons start a follow-up chord)
                                <input
                                  type="text"
                                  value={drafts[`${prefix}${i}:${which}.keys`] ?? chordsText(sub.keys, sub.then)}
                                  onChange={(e) => setDraft(`${prefix}${i}:${which}.keys`, e.target.value)}
                                />
                              </label>
                            ) : sub.type === "text" ? (
                              <label className="form-block">
                                Text to insert
                                <textarea
                                  rows={2}
                                  spellCheck={false}
                                  value={sub.text}
                                  onChange={(e) => updateToggleSub(i, which, { text: e.target.value })}
                                />
                              </label>
                            ) : (
                              <label className="form-block">
                                Command (run via bash)
                                <textarea
                                  rows={2}
                                  spellCheck={false}
                                  value={sub.command}
                                  onChange={(e) => updateToggleSub(i, which, { command: e.target.value })}
                                />
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </SortableCard>
              ))}
                </SortableContext>
              </DndContext>
              <button className="add-button" onClick={addButton}>
                + Add button
              </button>
            </Section>
          </>
        )}

        <details className="help">
          <summary>Config options explained</summary>
          <div className="help-body">
            <h3>profiles</h3>
            <p>
              Optional list of layouts (max 24), each with <code>id</code> (lowercase letters,
              digits, dashes), <code>name</code>, optional tab <code>icon</code>, its own{" "}
              <code>grid</code> and <code>buttons</code>, and an optional{" "}
              <code>match.apps</code> list. When <code>profiles</code> is present, top-level{" "}
              <code>grid</code>/<code>buttons</code> must be removed. Profiles show as tabs on the
              pad; the server auto-switches to the first profile whose <code>match.apps</code>{" "}
              entry is contained in the focused window's app id (case-insensitive). No match keeps
              the current tab.
            </p>
            <h3>server.focus</h3>
            <p>
              <code>pollMs</code> (250–10000, default 1000): how often the foreground app is
              probed. <code>command</code>: custom shell command printing the focused app id —
              overrides auto-detection (<code>swaymsg</code> for Sway/wlroots,{" "}
              <code>hyprctl</code> for Hyprland, <code>xdotool</code> for X11). Needed on GNOME
              Wayland, e.g. a gdbus call fetching the focused app's desktop id.
            </p>
            <h3>grid</h3>
            <p>
              <code>rows</code> / <code>cols</code> (1–12): the pad layout. Buttons fill the grid
              in the order they appear in the list (drag the grip to reorder); missing spots stay
              empty.
            </p>
            <h3>server</h3>
            <p>
              <code>port</code> (default 8787) and <code>bind</code> — <code>"lan"</code> makes the
              pad reachable from your phone on the local network, <code>"local"</code> restricts it
              to this machine. Both apply live on save: the server rebinds itself and clients
              reconnect (change the port and this page redirects to the new address).{" "}
              <code>shortcutBackend</code>: <code>auto</code> picks ydotool (Wayland) or xdotool
              (X11) when installed, then nut.js; <code>noop</code> only logs — handy for testing.{" "}
              <code>authToken</code> is the passcode every client must present (min 8 chars); it
              applies immediately on save. Clear it to be asked for a new one on the next server
              start.
            </p>
            <h3>buttons[]</h3>
            <p>
              <code>id</code> (unique per profile, 0–999) — also used by scripts and{" "}
              <code>button.setState</code>. <code>label</code> text under the icon.{" "}
              <code>icon</code>: emoji, <code>fa:icon-name</code> (FontAwesome solid;{" "}
              <code>far:</code>/<code>fab:</code> for regular/brand icons), short text/unicode
              (drawn as a hollow backlit legend), or an image URL/path. <code>color</code>:{" "}
              <code>#rrggbb</code>. <code>glow</code>: <code>off</code> | <code>solid</code> |{" "}
              <code>breathing</code>. <code>w</code>/<code>h</code> (1–4, default 1): tile span in
              grid columns/rows — wide tiles suit display content. <code>content</code> +
              optional <code>contentType</code> (<code>text</code> default, or{" "}
              <code>markdown</code>): text shown on the keycap face instead of icon/label;
              scripts can update it live via a state patch. Omit <code>action</code> entirely for
              a pure display tile that doesn't respond to taps.
            </p>
            <h3>action: text</h3>
            <p>
              <code>text</code> is inserted into the focused application. <code>method</code>:{" "}
              <code>type</code> (default) simulates keystrokes (xdotool/ydotool/nut.js) and leaves
              the clipboard alone; <code>paste</code> sets the clipboard via <code>xclip</code>{" "}
              (X11) or <code>wl-copy</code> (Wayland) and presses ctrl+v — instant for long text,
              but clobbers the clipboard and ctrl+v doesn't work in every app (e.g. terminals).
            </p>
            <h3>action: prompt</h3>
            <p>
              Like <code>text</code>, but the text is typed on the phone at tap time: a sheet
              slides up, you type, hit Insert, and it's typed/pasted into the focused app.{" "}
              <code>method</code> works as above; <code>placeholder</code> (optional) is the
              input hint shown in the sheet.
            </p>
            <h3>action: shortcut</h3>
            <p>
              <code>keys</code> are pressed in order and released in reverse, e.g.{" "}
              <code>["ctrl", "shift", "m"]</code>. An optional <code>then</code> list holds
              follow-up chords pressed in sequence after the main chord is released — for
              prefix-style apps like herdr/tmux: <code>keys: ["ctrl","b"]</code> +{" "}
              <code>then: [["c"]]</code> sends ctrl+b, then c (in the visual editor:{" "}
              <code>ctrl, b; c</code>). Names: modifiers <code>ctrl</code>,{" "}
              <code>shift</code>, <code>alt</code>, <code>super</code>; <code>enter</code>,{" "}
              <code>esc</code>, <code>space</code>, <code>tab</code>, <code>backspace</code>,{" "}
              <code>delete</code>, arrows (<code>up</code>/<code>down</code>/<code>left</code>/
              <code>right</code>), <code>home</code>, <code>end</code>, <code>pageup</code>,{" "}
              <code>pagedown</code>, <code>f1</code>–<code>f24</code>, single letters/digits, media
              keys <code>play</code>, <code>stop</code>, <code>next</code>, <code>prev</code>,{" "}
              <code>volup</code>, <code>voldown</code>, <code>mute</code>. Raw passthrough:
              xdotool accepts <code>code:36</code> (X11 keycode), <code>U+00E9</code> (Unicode
              code point), <code>sym:dead_acute</code> (any keysym), bare <code>XF86…</code>{" "}
              names; ydotool accepts <code>ev:30</code> (Linux input event code). Not available
              on nutjs.
            </p>
            <h3>action: script</h3>
            <p>
              <code>command</code> runs via bash; optional <code>cwd</code> and{" "}
              <code>timeoutMs</code> (default 30000, max 300000). <code>onSuccess</code> /{" "}
              <code>onError</code> are state patches applied to the button depending on the exit
              code. Additionally, if the script's last stdout line is a JSON patch like{" "}
              <code>{'{"color":"#00c853","glow":"breathing"}'}</code>, it is applied too (and wins
              over onSuccess/onError). Scripts receive <code>MACRO_PAD_WS</code> (RPC URL incl.
              passcode), <code>MACRO_PAD_BUTTON_ID</code> and <code>MACRO_PAD_PROFILE</code> in
              their environment, so long-running tools can keep updating buttons via{" "}
              <code>button.setState</code>.
            </p>
            <h3>action: toggle</h3>
            <p>
              A latching switch with <code>on</code> and <code>off</code> sub-actions (each a
              shortcut or script). Every press flips the server-tracked state and runs the matching
              sub-action; if it fails, the state reverts and an error is shown. While on, the key
              renders depressed with a solid glow — customize with <code>onState</code> (a state
              patch, default <code>{'{"glow":"solid"}'}</code>). Toggle states persist across
              server restarts in <code>state.json</code> next to the config file.
            </p>
            <h3>Saving &amp; safety</h3>
            <p>
              Save validates before writing: invalid JSON or schema errors are shown here and the
              running config is left untouched. Everything applies live — buttons, passcode, even
              port/bind (the server rebinds itself; external tools can trigger the same via the{" "}
              <code>server.restart</code> RPC). If the file on disk is broken (e.g. after a manual
              edit), the server keeps the last good config — or starts in repair mode with an empty
              pad — and this page stays reachable to fix it.
            </p>
          </div>
        </details>

      </div>
      <footer className="settings-footer">
        <button className="revert-button" onClick={load} disabled={saving}>
          Revert
        </button>
        <button
          className="save-button"
          onClick={save}
          disabled={
            saving ||
            !!loadError ||
            (mode === "visual" && !cfg) ||
            (mode === "json" && validation !== null && !validation.ok)
          }
        >
          {saving ? "Saving…" : "Save & apply"}
        </button>
      </footer>
    </div>
  );
}
