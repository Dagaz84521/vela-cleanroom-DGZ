import { useEffect } from "react";
import { useTimeTrackerStore } from "../store/time-tracker-store";
import { useTauriEvent } from "./use-tauri-event";

/** Commit invalidation uses the existing Tauri event hook, never whole-store echo broadcasts. */
export function useTimeTracker(day: string, active = true) {
  const snapshot = useTimeTrackerStore((s) => s.days[day]);
  const revision = useTimeTrackerStore((s) => s.revision);
  const load = useTimeTrackerStore((s) => s.load);
  useEffect(() => {
    if (active) void load(day);
  }, [day, active, revision, load]);
  useEffect(() => {
    const refresh = () => {
      if (active) void load(day);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [day, active, load]);
  return snapshot;
}

/** Exactly one event bridge per WebView, alongside the existing cross-window sync hook. */
export function useTimeTrackerSync(): void {
  useTauriEvent("sync:time-tracker", () => useTimeTrackerStore.getState().invalidate());
}
