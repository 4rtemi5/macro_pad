import { useMemo, type CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { resolveIcon } from "../icons";
import type { ButtonView } from "../types";

interface Props {
  button: ButtonView;
  onPress: () => void;
}

export function PadButton({ button, onPress }: Props) {
  const color = button.color ?? "#4a5160";
  const glow = button.glow ?? "off";
  const icon = button.icon ? resolveIcon(button.icon) : null;
  const hasContent = !!button.content;
  // No action configured → pure display tile: not pressable.
  const inert = !button.actionType;

  // Markdown → sanitized HTML. Recomputed only when the content changes.
  const contentHtml = useMemo(() => {
    if (!hasContent || button.contentType !== "markdown") return null;
    const html = marked.parse(button.content!, { async: false, breaks: true });
    return DOMPurify.sanitize(html);
  }, [hasContent, button.content, button.contentType]);

  const w = button.w ?? 1;
  const h = button.h ?? 1;
  const style = { "--btn-color": color } as CSSProperties;
  if (w > 1) style.gridColumn = `span ${w}`;
  if (h > 1) style.gridRow = `span ${h}`;
  if (w > 1 || h > 1) style.aspectRatio = `${w} / ${h}`;

  return (
    <button
      className={`pad-button glow-${glow}${button.on ? " toggle-on" : ""}`}
      style={style}
      disabled={inert}
      onPointerDown={(e) => {
        e.preventDefault();
        navigator.vibrate?.(15);
        onPress();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="keycap-bleed" aria-hidden="true" />
      <span className="keycap">
        <span className="keycap-top">
          {hasContent ? (
            contentHtml !== null ? (
              <span
                className="pad-content markdown"
                dangerouslySetInnerHTML={{ __html: contentHtml }}
              />
            ) : (
              <span className="pad-content">{button.content}</span>
            )
          ) : (
            <>
              {icon && (
                <span className={`pad-icon icon-${icon.kind}`}>
                  {icon.kind === "fa" ? (
                    <FontAwesomeIcon icon={icon.def} />
                  ) : icon.kind === "image" ? (
                    <img src={icon.src} alt="" draggable={false} />
                  ) : (
                    icon.text
                  )}
                </span>
              )}
              {button.label && <span className="pad-label">{button.label}</span>}
            </>
          )}
        </span>
      </span>
    </button>
  );
}
