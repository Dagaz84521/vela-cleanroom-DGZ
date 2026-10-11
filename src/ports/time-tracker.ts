import type { TimeCategory } from "../types/bindings/TimeCategory";
import type { TimeTrackerConfig } from "../types/bindings/TimeTrackerConfig";
import type { TimeTrackerSnapshot } from "../types/bindings/TimeTrackerSnapshot";
import type { TimeWriteResult } from "../types/bindings/TimeWriteResult";

export interface TimeTrackerPersistence {
  load(fromMs: number, toMs: number): Promise<TimeTrackerSnapshot>;
  configure(config: TimeTrackerConfig): Promise<void>;
  write(starts: number[], categoryId: string, note: string, overwrite: boolean): Promise<TimeWriteResult>;
  continueActivity(starts: number[]): Promise<TimeWriteResult>;
  saveCategory(category: TimeCategory): Promise<void>;
}
