import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_TIME_CONFIG, localDateKey } from "../../domain/time-tracker";
import type { TimeTrackerSnapshot } from "../../types/bindings/TimeTrackerSnapshot";
import type { TimeBlock } from "../../types/bindings/TimeBlock";

vi.mock("../../i18n-lite", () => ({
  useT: () => (text: string, vars?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? `{${key}}`))
}));
vi.mock("../../lib/use-now", () => ({ useNow: () => new Date(2026, 9, 10, 10, 35) }));
vi.mock("../widget-config", () => ({ useWidgetConfig: () => ({ config: {} }) }));
const widgetState = vi.hoisted(() => ({ instances: [{ id: "tracker", w: 340, h: 300 }], updateWidget: vi.fn() }));
vi.mock("../widget-store", () => ({ useWidgetStore: { getState: () => widgetState } }));
const expand = vi.hoisted(() => vi.fn());
vi.mock("../expand-store", () => ({ useWidgetExpand: { getState: () => ({ expand }) } }));
const persistence = vi.hoisted(() => ({
  load: vi.fn(),
  write: vi.fn(),
  continueActivity: vi.fn(),
  configure: vi.fn(),
  saveCategory: vi.fn()
}));
vi.mock("../../lib/persistence/time-tracker", () => ({ timeTrackerPersistence: persistence }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../../components/PromptDialog", () => ({ confirmDialog: confirm }));
import { TimeTrackerWidget } from "./TimeTrackerWidget";
import { useTimeTrackerStore } from "../../store/time-tracker-store";

const at = (hour: number, minute: number) => new Date(2026, 9, 10, hour, minute).getTime();
let snapshot: TimeTrackerSnapshot;
function block(start: number, category = "coding", note = "original"): TimeBlock {
  return {
    id: String(start),
    start_ms: start,
    end_ms: start + 600_000,
    local_date: localDateKey(new Date(start)),
    utc_offset_minutes: -new Date(start).getTimezoneOffset(),
    category_id: category,
    note,
    created_at: "created",
    updated_at: "updated"
  };
}
async function mount() {
  const result = render(<TimeTrackerWidget instanceId="tracker" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "快速记录" })).toBeEnabled());
  return result;
}
const cell = (range: string) => screen.getByRole("button", { name: new RegExp(range) });
const noteInput = () => screen.getByPlaceholderText("记录一点细节");
async function returned() {
  await waitFor(() => expect(screen.queryByRole("button", { name: "返回概览" })).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(at(10, 35));
  snapshot = {
    config: { ...DEFAULT_TIME_CONFIG, interval_minutes: 30 },
    categories: ["学习", "编程", "阅读", "工作", "娱乐", "休息", "生活", "其他"].map((name, i) => ({
      id: ["study", "coding", "reading", "work", "fun", "rest", "life", "other"][i],
      name,
      color: ["#eab308", "#8b5cf6", "#14b8a6", "#3b82f6", "#ec4899", "#22c55e", "#f97316", "#64748b"][i],
      builtin: true,
      archived: false
    })),
    blocks: [block(at(10, 0))],
    latest: block(at(10, 0)),
    continuous_start_ms: at(10, 0),
    pending: { start_ms: at(10, 0), end_ms: at(10, 30) },
    next: null
  };
  useTimeTrackerStore.setState({ days: {}, loading: false, saving: false, error: null, revision: 0 });
  persistence.load.mockImplementation(async (start: number, end: number) => ({
    ...snapshot,
    blocks: snapshot.blocks.filter((b) => b.start_ms >= start && b.start_ms < end)
  }));
  persistence.write.mockImplementation(async (starts: number[], category: string, note: string, overwrite: boolean) => {
    let written = 0,
      skipped = 0;
    for (const start of starts) {
      const index = snapshot.blocks.findIndex((b) => b.start_ms === start);
      if (index >= 0 && !overwrite) {
        skipped++;
        continue;
      }
      const value = block(start, category, note);
      if (index >= 0) snapshot.blocks[index] = { ...snapshot.blocks[index], category_id: category, note };
      else snapshot.blocks.push(value);
      written++;
    }
    snapshot.latest = [...snapshot.blocks].sort((a, b) => b.start_ms - a.start_ms)[0];
    return { written, skipped };
  });
  persistence.continueActivity.mockImplementation(async (starts: number[]) => {
    const previous = snapshot.blocks
      .filter((b) => b.end_ms <= Math.min(...starts))
      .sort((a, b) => b.end_ms - a.end_ms)[0];
    if (!previous) throw new Error("No previous activity");
    return persistence.write(starts, previous.category_id, previous.note, false);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Time Tracker compact widget", () => {
  it("refreshes the current tile and date immediately when Locate crosses midnight between display ticks", async () => {
    await mount();
    vi.mocked(Date.now).mockReturnValue(new Date(2026, 9, 11, 0, 3).getTime());
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    await waitFor(() => expect(screen.getByText("2026-10-11")).toBeInTheDocument());
    expect(cell("00:00–00:10")).toHaveClass("current");
    expect(cell("00:00–00:10")).toHaveAttribute("aria-pressed", "true");
    expect(cell("10:30–10:40")).not.toHaveClass("current");
  });
  it("draws 24 rows of six tiles and upgrades only undersized tracker instances", async () => {
    const { container } = await mount();
    expect(container.querySelectorAll(".tt-mini-hour")).toHaveLength(24);
    expect(container.querySelectorAll(".tt-mini-tile")).toHaveLength(144);
    expect(cell("10:00–10:10")).toHaveStyle({ background: "#8b5cf6" });
    expect(cell("10:30–10:40")).toHaveClass("future", "current");
    expect(screen.getByText("已记录 1 / 已结束 63 块")).toBeInTheDocument();
    expect(widgetState.updateWidget).toHaveBeenCalledWith("tracker", { w: 340, h: 450 });
  });
  it("switches pages, requires confirmation, skips existing blocks, and refreshes saved colors", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "快速记录" }));
    expect(screen.queryByRole("button", { name: "每日时间轴" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回概览" })).toHaveFocus();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.change(noteInput(), { target: { value: "details" } });
    expect(persistence.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await returned();
    expect(persistence.write).toHaveBeenCalledWith([at(10, 0), at(10, 10), at(10, 20)], "reading", "details", false);
    expect(cell("10:10–10:20")).toHaveAccessibleName(/阅读 · details/);
    expect(cell("10:10–10:20")).toHaveStyle({ background: "#14b8a6" });
    expect(cell("10:00–10:10")).toHaveAccessibleName(/编程 · original/);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("retains scroll position and draft on Back, with drafts isolated by time range", async () => {
    await mount();
    const scroll = screen.getByRole("region", { name: "今日时间块，可用鼠标滚轮滚动" });
    scroll.scrollTop = 216;
    fireEvent.scroll(scroll);
    fireEvent.click(screen.getByRole("button", { name: "快速记录" }));
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.change(noteInput(), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "返回概览" }));
    expect(scroll.scrollTop).toBe(216);
    fireEvent.doubleClick(cell("09:00–09:10"));
    expect(noteInput()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "返回概览" }));
    fireEvent.click(screen.getByRole("button", { name: "快速记录" }));
    expect(noteInput()).toHaveValue("draft");
    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-pressed", "true");
    expect(persistence.write).not.toHaveBeenCalled();
  });
  it("single-click shows details; double-click edits only one block without pinning the card", async () => {
    const onDoubleClick = vi.fn();
    render(
      <div onDoubleClick={onDoubleClick}>
        <TimeTrackerWidget instanceId="tracker" />
      </div>
    );
    await waitFor(() => expect(cell("10:00–10:10")).toBeInTheDocument());
    fireEvent.click(cell("10:00–10:10"));
    expect(screen.queryByPlaceholderText("记录一点细节")).not.toBeInTheDocument();
    fireEvent.doubleClick(cell("10:00–10:10"));
    expect(noteInput()).toHaveValue("original");
    expect(screen.getByRole("button", { name: "编程" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.change(noteInput(), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await returned();
    expect(persistence.write).toHaveBeenCalledWith([at(10, 0)], "reading", "edited", true);
    expect(cell("10:00–10:10")).toHaveAccessibleName(/阅读 · edited/);
    expect(snapshot.blocks).toHaveLength(1);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
  it("double-clicking a blank past block backfills that block; future blocks cannot open a form", async () => {
    await mount();
    fireEvent.doubleClick(cell("10:30–10:40"));
    expect(screen.queryByRole("button", { name: "返回概览" })).not.toBeInTheDocument();
    fireEvent.doubleClick(cell("09:00–09:10"));
    expect(screen.getByText("补记活动")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工作" }));
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await returned();
    expect(persistence.write).toHaveBeenCalledWith([at(9, 0)], "work", "", false);
    expect(cell("09:00–09:10")).toHaveAccessibleName(/工作/);
  });
  it("keeps the form and draft on a rejected database write", async () => {
    await mount();
    persistence.write.mockRejectedValueOnce(new Error("database locked"));
    fireEvent.doubleClick(cell("09:00–09:10"));
    fireEvent.click(screen.getByRole("button", { name: "工作" }));
    fireEvent.change(noteInput(), { target: { value: "retained" } });
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("database locked"));
    expect(noteInput()).toHaveValue("retained");
    expect(screen.getByRole("button", { name: "返回概览" })).toBeEnabled();
    expect(snapshot.blocks).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("continues the activity before the entire pending range, including its note", async () => {
    snapshot.blocks.unshift(block(at(9, 50), "reading", "previous note"));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "快速记录" }));
    fireEvent.click(screen.getByRole("button", { name: "延续上一活动" }));
    await returned();
    expect(persistence.continueActivity).toHaveBeenCalledWith([at(10, 0), at(10, 10), at(10, 20)]);
    expect(cell("10:20–10:30")).toHaveAccessibleName(/阅读 · previous note/);
  });
  it("in edit mode Continue prefills the previous activity and waits for Save changes", async () => {
    snapshot.blocks.unshift(block(at(9, 50), "reading", "previous note"));
    await mount();
    fireEvent.doubleClick(cell("10:00–10:10"));
    fireEvent.click(screen.getByRole("button", { name: "延续上一活动" }));
    expect(noteInput()).toHaveValue("previous note");
    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-pressed", "true");
    expect(persistence.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await returned();
    expect(persistence.write).toHaveBeenCalledWith([at(10, 0)], "reading", "previous note", true);
  });
  it("loads and writes both dates of a midnight pending reminder", async () => {
    const start = at(0, 0) - 1_800_000;
    snapshot.pending = { start_ms: start, end_ms: at(0, 30) };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "快速记录" }));
    await waitFor(() => expect(persistence.load).toHaveBeenCalledWith(at(0, 0) - 86_400_000, at(0, 0)));
    fireEvent.click(screen.getByRole("button", { name: "休息" }));
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await returned();
    expect(persistence.write).toHaveBeenCalledWith(
      Array.from({ length: 6 }, (_, i) => start + i * 600_000),
      "rest",
      "",
      false
    );
  });
  it("supports Enter to open, Escape to return, and the existing expanded timeline", async () => {
    await mount();
    const target = cell("09:00–09:10");
    target.focus();
    fireEvent.keyDown(target, { key: "Enter" });
    expect(noteInput()).toBeInTheDocument();
    fireEvent.keyDown(noteInput(), { key: "Escape", isComposing: true });
    expect(noteInput()).toBeInTheDocument();
    fireEvent.keyDown(noteInput(), { key: "Escape" });
    expect(target).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "每日时间轴" }));
    expect(expand).toHaveBeenCalledWith("tracker");
  });
});
