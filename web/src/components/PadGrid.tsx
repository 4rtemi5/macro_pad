import type { ButtonView, GridSpec } from "../types";
import { PadButton } from "./PadButton";

interface Props {
  grid: GridSpec;
  buttons: ButtonView[];
  onPress: (id: number) => void;
}

export function PadGrid({ grid, buttons, onPress }: Props) {
  // Buttons place themselves in config order; tiles with w/h span multiple
  // cells and grid-auto-flow: dense backfills any gaps.
  return (
    <div
      className="pad-grid"
      style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}
    >
      {buttons.map((b) => (
        <PadButton key={b.id} button={b} onPress={() => onPress(b.id)} />
      ))}
    </div>
  );
}
