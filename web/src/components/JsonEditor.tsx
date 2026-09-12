import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** Neon/glass editor chrome matching the app's "backlit deck" theme. */
const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "rgba(8, 10, 15, 0.75)",
      color: "#e8ecf4",
      border: "1px solid rgba(255, 255, 255, 0.09)",
      borderRadius: "12px",
      fontSize: "13px",
    },
    ".cm-scroller": {
      maxHeight: "62vh",
      minHeight: "45vh",
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: "1.55",
    },
    ".cm-content": {
      padding: "12px 0",
      caretColor: "#6ee7ff",
    },
    "&.cm-focused": {
      outline: "none",
      borderColor: "rgba(110, 231, 255, 0.45)",
      boxShadow: "0 0 0 3px rgba(110, 231, 255, 0.12), 0 0 24px rgba(110, 231, 255, 0.08)",
    },
    ".cm-gutters": {
      backgroundColor: "rgba(255, 255, 255, 0.02)",
      color: "#4b5263",
      border: "none",
      borderRight: "1px solid rgba(255, 255, 255, 0.06)",
      borderRadius: "12px 0 0 12px",
    },
    ".cm-activeLine": { backgroundColor: "rgba(110, 231, 255, 0.05)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8b93a5" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(110, 231, 255, 0.18)",
    },
    ".cm-selectionMatch": { backgroundColor: "rgba(192, 132, 252, 0.16)" },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(110, 231, 255, 0.14)",
      outline: "1px solid rgba(110, 231, 255, 0.35)",
    },
    ".cm-lintRange-error": {
      textDecoration: "underline wavy #ff5c7a",
      textUnderlineOffset: "3px",
    },
    ".cm-lint-marker": { width: "0.9em", height: "0.9em" },
    ".cm-tooltip": {
      backgroundColor: "rgba(15, 18, 26, 0.95)",
      border: "1px solid rgba(255, 255, 255, 0.12)",
      borderRadius: "8px",
      color: "#e8ecf4",
    },
    ".cm-tooltip.cm-tooltip-lint": { maxWidth: "min(420px, 80vw)" },
  },
  { dark: true },
);

/** JSON token colors: cyan keys, violet strings, amber numbers, pink literals. */
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "#6ee7ff" },
  { tag: tags.string, color: "#c4b5fd" },
  { tag: tags.number, color: "#ffd180" },
  { tag: [tags.bool, tags.null], color: "#f472b6" },
  { tag: tags.punctuation, color: "#8b93a5" },
]);

/**
 * CodeMirror-based JSON editor with syntax highlighting and live syntax
 * checking (wavy underlines + gutter markers). Schema-level checking happens
 * via the config.validate RPC in SettingsView.
 */
export function JsonEditor({ value, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount once; the value-sync effect below handles external replacements.
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          json(),
          linter(jsonParseLinter()),
          lintGutter(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
      parent: hostRef.current!,
    });
    viewRef.current = view;
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value replacement (mode switch, Revert) — not fired for edits
  // originating from the editor itself, since those already match.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="json-editor-cm" ref={hostRef} />;
}
