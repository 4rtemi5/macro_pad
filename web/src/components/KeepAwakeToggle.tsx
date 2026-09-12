import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLightbulb } from "@fortawesome/free-solid-svg-icons";

/** Device-local preference — deliberately not part of the server config. */
const PREF_KEY = "macroPadKeepAwake";

/* Minimal structural types: lib.dom's WakeLock declarations vary across TS
   versions, and feature detection needs the "maybe absent" shape anyway. */
interface WakeLockSentinelLike extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockLike | undefined {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

/**
 * "Keep screen on" switch backed by the Screen Wake Lock API.
 *
 * The lock is held only while the tab is visible — the browser drops it when
 * the page is hidden — so it is re-acquired on every visibilitychange. The
 * preference persists in localStorage and re-engages on the next visit.
 *
 * Requires a secure context: on plain http://<lan-ip> the API is absent and
 * the switch renders disabled with an explanation.
 */
export function KeepAwakeToggle() {
  const [wakeLock] = useState(getWakeLock);
  const [wanted, setWanted] = useState(() => localStorage.getItem(PREF_KEY) === "1");
  const [active, setActive] = useState(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  const request = useCallback(async () => {
    if (!wakeLock) return;
    try {
      const s = await wakeLock.request("screen");
      sentinelRef.current = s;
      setActive(true);
      s.addEventListener("release", () => {
        if (sentinelRef.current === s) sentinelRef.current = null;
        setActive(false);
      });
    } catch {
      // e.g. tab hidden mid-request or battery-saver refusal — the
      // visibilitychange handler retries when the page is shown again.
      setActive(false);
    }
  }, [wakeLock]);

  const release = useCallback(() => {
    const s = sentinelRef.current;
    sentinelRef.current = null;
    setActive(false);
    void s?.release().catch(() => {});
  }, []);

  useEffect(() => {
    if (!wakeLock || !wanted) {
      release();
      return;
    }
    if (document.visibilityState === "visible") void request();
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      release();
    };
  }, [wakeLock, wanted, request, release]);

  const toggle = () => {
    const next = !wanted;
    setWanted(next);
    localStorage.setItem(PREF_KEY, next ? "1" : "0");
  };

  return (
    <div className="keep-awake">
      <FontAwesomeIcon icon={faLightbulb} className={`keep-awake-icon${active ? " lit" : ""}`} />
      <div className="keep-awake-text">
        <span className="keep-awake-title">Keep screen on</span>
        <span className="keep-awake-note">
          {wakeLock
            ? active
              ? "Screen stays awake while this tab is visible."
              : wanted
                ? "On — the lock engages whenever this tab is visible."
                : "Prevent the display from sleeping — applies instantly, stored on this device only."
            : "Not available here — the browser only allows this over HTTPS or localhost."}
        </span>
      </div>
      <button
        role="switch"
        aria-checked={wanted}
        aria-label="Keep screen on"
        className={`switch${wanted ? " on" : ""}`}
        onClick={toggle}
        disabled={!wakeLock}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}
