import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  completedStarts,
  DEFAULT_TIME_CONFIG,
  dayBounds,
  floorBlock,
  localDateKey,
  mergeBlocks,
  nextReminder,
  quickRange,
  REMINDER_INTERVALS,
  reminderRanges,
  timelineBlocks
} from "./time-tracker";
import type { TimeBlock } from "../types/bindings/TimeBlock";

const at = (hour: number, minute = 0) => new Date(2026, 9, 10, hour, minute).getTime();
function record(start: number, category = "coding", note = ""): TimeBlock {
  return {
    id: String(start),
    start_ms: start,
    end_ms: start + 600_000,
    local_date: "2026-10-10",
    utc_offset_minutes: -new Date(start).getTimezoneOffset(),
    category_id: category,
    note,
    created_at: "2026-10-10T00:00:00Z",
    updated_at: "2026-10-10T00:00:00Z"
  };
}

describe("Time Tracker wall-clock rules", () => {
  it.each(REMINDER_INTERVALS)("anchors %i-minute reminders and preserves ten-minute recording", (interval) => {
    const config = { ...DEFAULT_TIME_CONFIG, interval_minutes: interval };
    const next = nextReminder(at(7), config)!;
    expect(next.start_ms).toBe(at(7));
    expect(next.end_ms).toBe(at(7) + interval * 60_000);
    expect(completedStarts(next, next.end_ms)).toHaveLength(interval / 10);
  });
  it("non-boundary startup targets the next reminder, without changing its range", () => {
    expect(nextReminder(at(10, 7), DEFAULT_TIME_CONFIG)).toEqual({ start_ms: at(10), end_ms: at(10, 10) });
    expect(floorBlock(at(10, 7) + 12_345)).toBe(at(10));
  });
  it("fifty-minute cycles cross hours and finish with a short tail", () => {
    const c = { ...DEFAULT_TIME_CONFIG, interval_minutes: 50 };
    expect(nextReminder(at(7, 51), c)).toEqual({ start_ms: at(7, 50), end_ms: at(8, 40) });
    expect(nextReminder(at(22, 55), c)).toEqual({ start_ms: at(22, 50), end_ms: at(23) });
  });
  it("before/after active hours and overnight boundaries stay anchored", () => {
    expect(nextReminder(at(6, 59), DEFAULT_TIME_CONFIG)?.end_ms).toBe(at(7, 10));
    expect(nextReminder(at(23), DEFAULT_TIME_CONFIG)?.end_ms).toBe(new Date(2026, 9, 11, 7, 10).getTime());
    const c = { ...DEFAULT_TIME_CONFIG, start_minute: 1380, end_minute: 60, interval_minutes: 40 };
    expect(nextReminder(at(23, 50), c)?.end_ms).toBe(new Date(2026, 9, 11, 0, 20).getTime());
    expect(nextReminder(at(10), { ...c, enabled: false })).toBeNull();
  });
  it("config edits recalculate the next reminder without mutating old records", () => {
    const old = [record(at(10))];
    expect(nextReminder(at(10, 12), { ...DEFAULT_TIME_CONFIG, interval_minutes: 60 })?.end_ms).toBe(at(11));
    expect(old[0].end_ms).toBe(at(10, 10));
    expect(reminderRanges(at(10), { ...DEFAULT_TIME_CONFIG, start_minute: 421 })).toEqual([]);
  });
  it("only completed blocks are eligible, including ranges across midnight", () => {
    expect(completedStarts({ start_ms: at(10), end_ms: at(10, 30) }, at(10, 25))).toEqual([at(10), at(10, 10)]);
    expect(completedStarts({ start_ms: at(10, 5), end_ms: at(10, 25) }, at(12))).toEqual([at(10, 10)]);
    const midnight = new Date(2026, 9, 11).getTime();
    expect(
      completedStarts({ start_ms: midnight - 20 * 60_000, end_ms: midnight + 10 * 60_000 }, midnight + 10 * 60_000)
    ).toHaveLength(3);
  });
  it("keeps the exact pending range instead of inferring unrecorded activities", () => {
    const pending = { start_ms: at(10), end_ms: at(10, 40) };
    expect(quickRange(at(11), DEFAULT_TIME_CONFIG, pending)).toEqual(pending);
    const blocks = timelineBlocks("2026-10-10", [record(at(10))], at(12));
    expect(blocks.filter((b) => b.record)).toHaveLength(1);
    expect(blocks.find((b) => b.start_ms === at(10, 10))?.record).toBeUndefined();
  });
  it("merges only adjacent matching activities and notes, preserving raw records", () => {
    const records = [
      record(at(10)),
      record(at(10, 10)),
      record(at(10, 30)),
      record(at(10, 40), "reading"),
      record(at(10, 50), "reading", "different")
    ];
    const blocks = timelineBlocks("2026-10-10", records, at(12)).filter(
      (b) => b.start_ms >= at(10) && b.start_ms < at(11)
    );
    const merged = mergeBlocks(blocks);
    expect(merged.map((m) => [m.category_id, m.count])).toEqual([
      ["coding", 2],
      [null, 1],
      ["coding", 1],
      ["reading", 1],
      ["reading", 1]
    ]);
    expect(records).toHaveLength(5);
  });
  it("rejects invalid calendar dates and uses the local calendar day", () => {
    expect(localDateKey(new Date(at(10)))).toBe("2026-10-10");
    expect(() => dayBounds("2026-02-30")).toThrow();
    expect(() => dayBounds("bad")).toThrow();
  });
  it("DST spring/fall timelines contain 138/150 distinct instants", () => {
    // Run the real pure module in a separate process so jsdom/worker TZ caching
    // cannot hide a DST regression. TypeScript is an existing project dependency.
    const src = readFileSync("src/domain/time-tracker.ts", "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }).outputText;
    const url = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
    const script = `const m=await import(${JSON.stringify(url)}); const days=['2024-03-10','2024-11-03']; const out=days.map(day=>{const b=m.timelineBlocks(day,[],Infinity);return [b.length,new Set(b.map(x=>x.start_ms)).size,new Set(b.map(x=>x.offset_minutes)).size]}); console.log(JSON.stringify(out));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
      timeout: 10_000
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [138, 138, 2],
      [150, 150, 2]
    ]);
  });
});
