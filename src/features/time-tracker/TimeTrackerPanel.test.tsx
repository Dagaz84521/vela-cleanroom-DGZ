import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_TIME_CONFIG } from "../../domain/time-tracker";
import type { TimeTrackerSnapshot } from "../../types/bindings/TimeTrackerSnapshot";

vi.mock("../../i18n-lite", () => ({
  useT: () => (text: string, vars?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? `{${key}}`))
}));
vi.mock("../../lib/use-now", () => ({ useNow: () => new Date(2026, 9, 10, 10, 35) }));
const data = vi.hoisted(() => ({ snapshot: null as TimeTrackerSnapshot | null }));
vi.mock("../../lib/use-time-tracker", () => ({
  useTimeTracker: (day: string) =>
    data.snapshot && { ...data.snapshot, blocks: data.snapshot.blocks.filter((b) => b.local_date === day) }
}));
vi.mock("../../components/DatePicker", () => ({
  DatePicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="选择日期" value={value} onChange={(e) => onChange(e.target.value)} />
  )
}));
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
import { TimeTrackerPanel } from "./TimeTrackerPanel";
import { useTimeTrackerStore } from "../../store/time-tracker-store";
const at = (hour: number, minute: number) => new Date(2026, 9, 10, hour, minute).getTime();

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  data.snapshot = {
    config: { ...DEFAULT_TIME_CONFIG, interval_minutes: 30 },
    categories: [
      { id: "coding", name: "编程", color: "#8b5cf6", builtin: true, archived: false },
      { id: "reading", name: "阅读", color: "#14b8a6", builtin: true, archived: false },
      { id: "fun", name: "娱乐", color: "#ec4899", builtin: true, archived: false }
    ],
    blocks: [
      {
        id: "old",
        start_ms: at(10, 0),
        end_ms: at(10, 10),
        local_date: "2026-10-10",
        utc_offset_minutes: 480,
        category_id: "coding",
        note: "original",
        created_at: "a",
        updated_at: "a"
      }
    ],
    latest: null,
    continuous_start_ms: null,
    pending: { start_ms: at(10, 0), end_ms: at(10, 30) },
    next: null
  };
  useTimeTrackerStore.setState({ days: {}, loading: false, saving: false, error: null, revision: 0 });
  persistence.write.mockResolvedValue({ written: 1, skipped: 0 });
  persistence.continueActivity.mockResolvedValue({ written: 3, skipped: 0 });
  confirm.mockResolvedValue(true);
});

describe("Time Tracker timeline interaction", () => {
  it("always draws ten-minute cells, distinguishes categories, blanks, and future blocks", () => {
    render(<TimeTrackerPanel />);
    const cells = screen.getAllByRole("button").filter((b) => b.classList.contains("tt-time-block"));
    expect(cells).toHaveLength(144);
    expect(screen.getByText("娱乐")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /10:00–10:10 · 编程/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /10:10–10:20 · 未记录/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /10:30–10:40 · 未记录/ })).toBeDisabled();
  });
  it("edits exactly one historical block only after replacement confirmation", async () => {
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: /10:00–10:10 · 编程/ }));
    expect(screen.getByPlaceholderText("记录一点细节")).toHaveValue("original");
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await waitFor(() => expect(persistence.write).toHaveBeenCalledWith([at(10, 0)], "reading", "original", true));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("backfills a selected range and skips existing data by default", async () => {
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: /10:00–10:10 · 编程/ }));
    fireEvent.click(screen.getByRole("button", { name: /10:20–10:30 · 未记录/ }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await waitFor(() =>
      expect(persistence.write).toHaveBeenCalledWith([at(10, 0), at(10, 10), at(10, 20)], "reading", "", false)
    );
    expect(confirm).not.toHaveBeenCalled();
  });
  it("does not write if the user declines overwriting existing history", async () => {
    confirm.mockResolvedValue(false);
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: /10:00–10:10 · 编程/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认记录" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(persistence.write).not.toHaveBeenCalled();
  });
  it("continues the complete thirty-minute pending range", async () => {
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: "记录最近提醒" }));
    fireEvent.click(screen.getByRole("button", { name: "延续上一活动" }));
    await waitFor(() => expect(persistence.continueActivity).toHaveBeenCalledWith([at(10, 0), at(10, 10), at(10, 20)]));
  });
  it("loads both dates for a midnight reminder before counting overwrite conflicts", async () => {
    const start = new Date(2026, 9, 9, 23, 30).getTime();
    const original = data.snapshot!.blocks[0];
    data.snapshot!.pending = { start_ms: start, end_ms: at(0, 30) };
    data.snapshot!.blocks = [
      { ...original, id: "before-midnight", start_ms: start + 1_200_000, end_ms: at(0, 0), local_date: "2026-10-09" },
      { ...original, id: "after-midnight", start_ms: at(0, 10), end_ms: at(0, 20) }
    ];
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: "记录最近提醒" }));
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "覆盖已选记录" }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: "将修改 2 个已记录时间块，其余历史保持不变。" })
      )
    );
    await waitFor(() =>
      expect(persistence.write).toHaveBeenCalledWith(
        Array.from({ length: 6 }, (_, i) => start + i * 600_000),
        "reading",
        "",
        true
      )
    );
  });
  it("changing the date clears selection and renders the chosen local day", () => {
    render(<TimeTrackerPanel />);
    fireEvent.click(screen.getByRole("button", { name: /10:00–10:10 · 编程/ }));
    fireEvent.change(screen.getByLabelText("选择日期"), { target: { value: "2026-10-09" } });
    expect(screen.queryByRole("button", { name: "确认记录" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("选择日期")).toHaveValue("2026-10-09");
  });
});
