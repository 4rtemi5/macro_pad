import { useState, type FormEvent } from "react";

interface Props {
  error: string | null;
  busy: boolean;
  onSubmit: (passcode: string) => void;
}

export function PasscodeGate({ error, busy, onSubmit }: Props) {
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value && !busy) onSubmit(value);
  };

  return (
    <form className="auth-gate" onSubmit={submit} autoComplete="off">
      <div className="auth-icon">🎛️</div>
      <h1>Macro Pad</h1>
      <p>Enter the passcode configured on the server.</p>
      <input
        type="password"
        inputMode="text"
        autoFocus
        placeholder="passcode"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      {error && <div className="auth-error">{error}</div>}
      <button type="submit" disabled={busy || !value}>
        {busy ? "Checking…" : "Unlock"}
      </button>
    </form>
  );
}
