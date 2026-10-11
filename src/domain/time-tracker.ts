import type { TimeBlock } from "../types/bindings/TimeBlock";
import type { TimeRange } from "../types/bindings/TimeRange";
import type { TimeTrackerConfig } from "../types/bindings/TimeTrackerConfig";

export const TIME_BLOCK_MS = 600_000;
export const REMINDER_INTERVALS = [10, 20, 30, 40, 50, 60] as const;
export const DEFAULT_TIME_CONFIG: TimeTrackerConfig = {
  enabled: true,
  interval_minutes: 10,
  start_minute: 420,
  end_minute: 1380
};

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayBounds(key: string): TimeRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("Invalid date");
  const [year, month, day] = key.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (localDateKey(start) !== key) throw new Error("Invalid date");
  const end = new Date(year, month - 1, day + 1);
  return { start_ms: start.getTime(), end_ms: end.getTime() };
}

/** Subtract within the current offset rather than setMinutes (which collapses DST folds). */
export function floorBlock(ms: number): number {
  const d = new Date(ms);
  return ms - (d.getMinutes() % 10) * 60_000 - d.getSeconds() * 1000 - d.getMilliseconds();
}

export function completedStarts(range: TimeRange, nowMs: number): number[] {
  const starts: number[] = [];
  const first = floorBlock(range.start_ms);
  for (
    let ms = first < range.start_ms ? first + TIME_BLOCK_MS : first;
    ms + TIME_BLOCK_MS <= Math.min(range.end_ms, nowMs);
    ms += TIME_BLOCK_MS
  ) {
    starts.push(ms);
  }
  return starts;
}

export type TimelineBlock = TimeRange & { record?: TimeBlock; complete: boolean; offset_minutes: number };
export function timelineBlocks(day: string, records: TimeBlock[], nowMs: number): TimelineBlock[] {
  const range = dayBounds(day);
  const byStart = new Map(records.map((r) => [r.start_ms, r]));
  const blocks: TimelineBlock[] = [];
  for (let start = range.start_ms; start < range.end_ms; start += TIME_BLOCK_MS) {
    blocks.push({
      start_ms: start,
      end_ms: start + TIME_BLOCK_MS,
      record: byStart.get(start),
      complete: start + TIME_BLOCK_MS <= nowMs,
      offset_minutes: -new Date(start).getTimezoneOffset()
    });
  }
  return blocks;
}

/** A summary only; original ten-minute records are never rewritten by merging. */
export function mergeBlocks(
  blocks: TimelineBlock[]
): { start_ms: number; end_ms: number; category_id: string | null; note: string; count: number }[] {
  const merged: ReturnType<typeof mergeBlocks> = [];
  for (const block of blocks) {
    const category_id = block.record?.category_id ?? null;
    const note = block.record?.note ?? "";
    const last = merged.at(-1);
    if (last && last.end_ms === block.start_ms && last.category_id === category_id && last.note === note) {
      last.end_ms = block.end_ms;
      last.count += 1;
    } else merged.push({ start_ms: block.start_ms, end_ms: block.end_ms, category_id, note, count: 1 });
  }
  return merged;
}

function boundary(day: Date, minute: number): number {
  // Find the first valid boundary if the requested wall time is inside a DST gap.
  for (let shift = 0; shift <= 180; shift += 10) {
    const desired = minute + shift;
    const candidate = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(desired / 60),
      desired % 60
    );
    if (candidate.getHours() === Math.floor(desired / 60) % 24 && candidate.getMinutes() === desired % 60)
      return candidate.getTime();
  }
  return NaN;
}

export function reminderRanges(nowMs: number, config: TimeTrackerConfig): TimeRange[] {
  if (
    !REMINDER_INTERVALS.some((n) => n === config.interval_minutes) ||
    config.start_minute === config.end_minute ||
    config.start_minute % 10 ||
    config.end_minute % 10 ||
    config.start_minute < 0 ||
    config.end_minute < 0 ||
    config.start_minute >= 1440 ||
    config.end_minute >= 1440
  )
    return [];
  const now = new Date(nowMs);
  const ranges: TimeRange[] = [];
  for (let offset = -1; offset <= 1; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const endDay = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate() + (config.end_minute < config.start_minute ? 1 : 0)
    );
    const end = boundary(endDay, config.end_minute);
    for (let start = boundary(day, config.start_minute); start < end;) {
      const next = Math.min(start + config.interval_minutes * 60_000, end);
      ranges.push({ start_ms: start, end_ms: next });
      start = next;
    }
  }
  return ranges.sort((a, b) => a.end_ms - b.end_ms);
}

export function nextReminder(nowMs: number, config: TimeTrackerConfig): TimeRange | null {
  return config.enabled ? (reminderRanges(nowMs, config).find((r) => r.end_ms > nowMs) ?? null) : null;
}

export function quickRange(nowMs: number, config: TimeTrackerConfig, pending: TimeRange | null): TimeRange {
  if (pending && pending.end_ms <= nowMs) return pending;
  const recent = reminderRanges(nowMs, config)
    .filter((r) => r.end_ms <= nowMs)
    .at(-1);
  const end = floorBlock(nowMs);
  return recent ?? { start_ms: end - TIME_BLOCK_MS, end_ms: end };
}

export function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
export function offsetLabel(minutes: number): string {
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}
