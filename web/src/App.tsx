import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGear } from "@fortawesome/free-solid-svg-icons";
import { RpcClient } from "./rpcClient";
import { PadGrid } from "./components/PadGrid";
import { ProfileTabs } from "./components/ProfileTabs";
import { PasscodeGate } from "./components/PasscodeGate";
import { SettingsView } from "./components/SettingsView";
import { TextPrompt } from "./components/TextPrompt";
import type { ButtonStateNotification, ButtonView, PadSnapshot, ProfileNotification } from "./types";

const TOKEN_KEY = "macroPadToken";
const AUTH_COOKIE = "macro_pad_token";

/** Token from ?token= (scrubbed from the URL afterwards) or localStorage. */
function getStoredToken(): string | null {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    params.delete("token");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

function persistToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  // The browser sends this cookie on the WebSocket upgrade, so the passcode
  // never has to appear in the WS URL.
  document.cookie = `${AUTH_COOKIE}=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${AUTH_COOKIE}=; path=/; max-age=0`;
}

function wsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/rpc?token=${encodeURIComponent(token)}`;
}

type CheckResult = "ok" | "unauthorized" | "unreachable";

async function checkToken(token: string | null): Promise<CheckResult> {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  try {
    const res = await fetch(`/auth/check${q}`);
    return res.status === 204 ? "ok" : "unauthorized";
  } catch {
    return "unreachable";
  }
}

type Phase = "checking" | "auth" | "pad";

export default function App() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<PadSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"pad" | "settings">("pad");
  const [promptFor, setPromptFor] = useState<ButtonView | null>(null);
  const clientRef = useRef<RpcClient | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const connect = useCallback(
    (token: string) => {
      clientRef.current?.close();
      persistToken(token);
      const client = new RpcClient(wsUrl(token));
      clientRef.current = client;

      client.onConnectionChange((ok) => {
        setConnected(ok);
        if (ok) {
          client
            .call<PadSnapshot>("pad.getState")
            .then((snap) => {
              setSnapshot(snap);
              setPhase("pad");
            })
            .catch((e: Error) => showToast(e.message));
        }
      });
      client.on<ButtonStateNotification>("button.state", (view) => {
        setSnapshot((snap) =>
          snap
            ? { ...snap, buttons: snap.buttons.map((b) => (b.id === view.id ? { ...b, ...view } : b)) }
            : snap,
        );
      });
      const refetch = () =>
        client.call<PadSnapshot>("pad.getState").then(setSnapshot).catch(() => {});
      client.on("pad.config", refetch);
      client.on<ProfileNotification>("pad.profile", refetch);
      client.connect();
    },
    [showToast],
  );

  // On load: try the stored passcode, otherwise show the gate.
  useEffect(() => {
    const token = getStoredToken();
    void checkToken(token).then((result) => {
      if (result === "ok" && token) {
        connect(token);
      } else {
        if (result === "unreachable") setAuthError("Server unreachable — is it running?");
        setPhase("auth");
      }
    });
    return () => clientRef.current?.close();
  }, [connect]);

  const submitPasscode = useCallback(
    (passcode: string) => {
      setBusy(true);
      setAuthError(null);
      void checkToken(passcode).then((result) => {
        setBusy(false);
        if (result === "ok") connect(passcode);
        else if (result === "unauthorized") setAuthError("Wrong passcode");
        else setAuthError("Server unreachable — is it running?");
      });
    },
    [connect],
  );

  const changePasscode = useCallback(() => {
    clearToken();
    clientRef.current?.close();
    setSnapshot(null);
    setConnected(false);
    setAuthError(null);
    setPhase("auth");
  }, []);

  const press = useCallback(
    (id: number) => {
      // Prompt buttons open the text sheet first; the actual press happens
      // on submit, carrying the typed text.
      const btn = snapshot?.buttons.find((b) => b.id === id);
      if (btn?.actionType === "prompt") {
        setPromptFor(btn);
        return;
      }
      clientRef.current
        ?.call<{ ok: boolean; error?: string }>("button.press", { id })
        .then((r) => {
          if (!r.ok) showToast(r.error ?? "action failed");
        })
        .catch((e: Error) => showToast(e.message));
    },
    [showToast, snapshot],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const btn = promptFor;
      setPromptFor(null);
      if (!btn) return;
      clientRef.current
        ?.call<{ ok: boolean; error?: string }>("button.press", { id: btn.id, text })
        .then((r) => {
          if (!r.ok) showToast(r.error ?? "action failed");
        })
        .catch((e: Error) => showToast(e.message));
    },
    [promptFor, showToast],
  );

  const selectProfile = useCallback(
    (id: string) => {
      clientRef.current
        ?.call("pad.setProfile", { id })
        // The pad.profile notification triggers the refetch; this catch only
        // surfaces real errors (unknown id, disconnect).
        .catch((e: Error) => showToast(e.message));
    },
    [showToast],
  );

  if (phase === "checking") {
    return <div className="status">Connecting…</div>;
  }
  if (phase === "auth") {
    return <PasscodeGate error={authError} busy={busy} onSubmit={submitPasscode} />;
  }
  if (!snapshot) {
    return <div className="status">{connected ? "Loading pad…" : "Connecting…"}</div>;
  }

  const client = clientRef.current;
  return (
    <>
      <button className="settings-gear" onClick={() => setView("settings")} aria-label="Settings">
        <FontAwesomeIcon icon={faGear} />
      </button>
      <div className="pad-stack">
        <ProfileTabs
          profiles={snapshot.profiles}
          activeProfile={snapshot.activeProfile}
          onSelect={selectProfile}
        />
        <PadGrid grid={snapshot.grid} buttons={snapshot.buttons} onPress={press} />
      </div>
      {view === "settings" && client && (
        <SettingsView client={client} onClose={() => setView("pad")} />
      )}
      {promptFor && (
        <TextPrompt
          label={promptFor.label}
          placeholder={promptFor.placeholder}
          onSubmit={submitPrompt}
          onCancel={() => setPromptFor(null)}
        />
      )}
      {!connected && (
        <div className="toast">
          reconnecting…{" "}
          <button className="toast-action" onClick={changePasscode}>
            change passcode
          </button>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
