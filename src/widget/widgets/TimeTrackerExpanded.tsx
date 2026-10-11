import { TimeTrackerPanel } from "../../features/time-tracker/TimeTrackerPanel";
import type { ExpandedComponentProps } from "../expand-store";
import "../../styles/feature-immersive.css";

export function TimeTrackerExpanded({ active }: ExpandedComponentProps) {
  return (
    <div className="imm-reuse">
      <TimeTrackerPanel active={active} />
    </div>
  );
}
