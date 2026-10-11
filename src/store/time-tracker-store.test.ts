import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeTrackerSnapshot } from "../types/bindings/TimeTrackerSnapshot";
import { DEFAULT_TIME_CONFIG } from "../domain/time-tracker";

const persistence = vi.hoisted(() => ({
  load: vi.fn(),
  write: vi.fn(),
  configure: vi.fn(),
  continueActivity: vi.fn(),
  saveCategory: vi.fn()
}));
vi.mock("../lib/persistence/time-tracker", () => ({ timeTrackerPersistence: persistence }));
import { useTimeTrackerStore } from "./time-tracker-store";
const day = "2026-10-10";
const snapshot = (): TimeTrackerSnapshot => ({
  config: { ...DEFAULT_TIME_CONFIG },
  categories: [],
  blocks: [],
  latest: null,
  continuous_start_ms: null,
  pending: null,
  next: null
});

beforeEach(() => {
  vi.clearAllMocks();
  useTimeTrackerStore.setState({ days: {}, loading: false, saving: false, error: null, revision: 0 });
  persistence.load.mockResolvedValue(snapshot());
});

describe("Time Tracker persist-first state", () => {
  it("hydrates configuration and history after restarting the UI", async () => {
    const persisted = { ...snapshot(), config: { ...DEFAULT_TIME_CONFIG, interval_minutes: 30 } };
    persistence.load.mockResolvedValue(persisted);
    await useTimeTrackerStore.getState().load(day);
    expect(useTimeTrackerStore.getState().days[day].config.interval_minutes).toBe(30);
  });
  it("single-flights multiple instances requesting the same day", async () => {
    await Promise.all([0, 1, 2].map(() => useTimeTrackerStore.getState().load(day)));
    expect(persistence.load).toHaveBeenCalledTimes(1);
  });
  it("does not mutate UI history or report success on a failed database write", async () => {
    await useTimeTrackerStore.getState().load(day);
    const old = useTimeTrackerStore.getState().days[day];
    persistence.write.mockRejectedValue({ message: "disk full" });
    await expect(useTimeTrackerStore.getState().record([123], "coding", "note")).rejects.toEqual({
      message: "disk full"
    });
    expect(useTimeTrackerStore.getState().days[day]).toBe(old);
    expect(useTimeTrackerStore.getState().error).toBe("disk full");
    expect(useTimeTrackerStore.getState().saving).toBe(false);
  });
  it("refreshes committed records immediately and keeps default writes non-destructive", async () => {
    await useTimeTrackerStore.getState().load(day);
    persistence.write.mockResolvedValue({ written: 3, skipped: 1 });
    const reloaded = { ...snapshot(), config: { ...DEFAULT_TIME_CONFIG, interval_minutes: 40 } };
    persistence.load.mockResolvedValue(reloaded);
    expect(await useTimeTrackerStore.getState().record([1, 2, 3], "reading", "note")).toEqual({
      written: 3,
      skipped: 1
    });
    expect(persistence.write).toHaveBeenCalledWith([1, 2, 3], "reading", "note", false);
    expect(useTimeTrackerStore.getState().days[day]).toBe(reloaded);
  });
  it("passes the entire selected reminder range to continue previous activity", async () => {
    persistence.continueActivity.mockResolvedValue({ written: 4, skipped: 0 });
    await useTimeTrackerStore.getState().continueActivity([1, 2, 3, 4]);
    expect(persistence.continueActivity).toHaveBeenCalledWith([1, 2, 3, 4]);
  });
  it("keeps configuration unchanged when saving fails", async () => {
    await useTimeTrackerStore.getState().load(day);
    persistence.configure.mockRejectedValue(new Error("write denied"));
    await expect(
      useTimeTrackerStore.getState().configure({ ...DEFAULT_TIME_CONFIG, interval_minutes: 60 })
    ).rejects.toThrow("write denied");
    expect(useTimeTrackerStore.getState().days[day].config.interval_minutes).toBe(10);
  });
  it("rejects a stale read invalidated by a commit and reloads the authoritative snapshot", async () => {
    let resolve!: (value: TimeTrackerSnapshot) => void;
    persistence.load.mockImplementationOnce(
      () =>
        new Promise<TimeTrackerSnapshot>((r) => {
          resolve = r;
        })
    );
    const read = useTimeTrackerStore.getState().load(day);
    useTimeTrackerStore.getState().invalidate();
    const updated = { ...snapshot(), config: { ...DEFAULT_TIME_CONFIG, interval_minutes: 50 } };
    persistence.load.mockResolvedValue(updated);
    resolve(snapshot());
    await read;
    await useTimeTrackerStore.getState().load(day);
    expect(useTimeTrackerStore.getState().days[day]).toBe(updated);
  });
});
