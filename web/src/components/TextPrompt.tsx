import { useEffect, useRef, useState } from "react";

interface Props {
  /** Label of the button that opened the sheet. */
  label?: string;
  /** Input hint from the button's config. */
  placeholder?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/**
 * Bottom sheet for prompt buttons: type text on the phone, it gets typed /
 * pasted into the focused app on the computer. Enter submits, Escape or a tap
 * on the backdrop cancels.
 */
export function TextPrompt({ label, placeholder, onSubmit, onCancel }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="prompt-overlay" onClick={onCancel}>
      <form
        className="prompt-sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (text) onSubmit(text);
        }}
      >
        <div className="prompt-title">{label || "Insert text"}</div>
        <input
          ref={inputRef}
          type="text"
          value={text}
          placeholder={placeholder || "Type text…"}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={4096}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="prompt-actions">
          <button type="button" className="prompt-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="prompt-send" disabled={!text}>
            Insert
          </button>
        </div>
      </form>
    </div>
  );
}
