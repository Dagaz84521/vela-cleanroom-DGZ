import { create } from "zustand";
import { dayBounds, localDateKey } from "../domain/time-tracker";
import { timeTrackerPersistence } from "../lib/persistence/time-tracker";
import type { TimeCategory } from "../types/bindings/TimeCategory";
import type { TimeTrackerConfig } from "../types/bindings/TimeTrackerConfig";
import type { TimeTrackerSnapshot } from "../types/bindings/TimeTrackerSnapshot";
import type { TimeWriteResult } from "../types/bindings/TimeWriteResult";

type TrackerState = {
  days: Record<string, TimeTrackerSnapshot>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  revision: number;
  load(day: string): Promise<void>;
  record(starts: number[], categoryId: string, note: string, overwrite?: boolean): Promise<TimeWriteResult>;
  continueActivity(starts: number[]): Promise<TimeWriteResult>;
  configure(config: TimeTrackerConfig): Promise<void>;
  saveCategory(category: TimeCategory): Promise<void>;
  invalidate(): void;
};

const inflight = new Map<string, Promise<void>>();
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);

export const useTimeTrackerStore = create<TrackerState>((set, get) => {
  async function persist<T>(action: () => Promise<T>): Promise<T> {
    set({ saving: true, error: null });
    try {
      const result = await action(); // Persist first: rejected IPC must never report success.
      get().invalidate();
      // Refresh loaded days after commit. A read failure keeps old content plus an error.
      await Promise.all(Object.keys(get().days).map((day) => get().load(day)));
      return result;
    } catch (error) {
      set({ error: errorText(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  }
  return {
    days: {},
    loading: false,
    saving: false,
    error: null,
    revision: 0,
    invalidate: () => set((s) => ({ revision: s.revision + 1 })),
    load: (day) => {
      const existing = inflight.get(day);
      if (existing) return existing;
      const revision = get().revision;
      const range = dayBounds(day);
      set({ loading: true, error: null });
      const run = timeTrackerPersistence
        .load(range.start_ms, range.end_ms)
        .then((snapshot) => {
          // A commit event arriving while reading makes this snapshot obsolete.
          if (revision !== get().revision) return;
          set((state) => {
            const days = { ...state.days, [day]: snapshot };
            // Keep recently viewed days bounded; history itself stays in SQLite.
            const keys = Object.keys(days).filter((k) => k !== day);
            for (const key of keys.slice(0, Math.max(0, keys.length - 6))) delete days[key];
            return { days };
          });
        })
        .catch((error: unknown) => {
          set({ error: errorText(error) });
        })
        .finally(() => {
          inflight.delete(day);
          set({ loading: inflight.size > 0 });
          if (revision !== get().revision) return get().load(day);
        });
      inflight.set(day, run);
      return run;
    },
    record: (starts, categoryId, note, overwrite = false) =>
      persist(() => timeTrackerPersistence.write(starts, categoryId, note, overwrite)),
    continueActivity: (starts) => persist(() => timeTrackerPersistence.continueActivity(starts)),
    configure: (config) => persist(() => timeTrackerPersistence.configure(config)),
    saveCategory: (category) => persist(() => timeTrackerPersistence.saveCategory(category))
  };
});

export function todayTrackerKey(): string {
  return localDateKey(new Date());
}
