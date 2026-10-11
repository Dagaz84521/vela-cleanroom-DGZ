import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_TIME_CONFIG } from "../../domain/time-tracker";
import type { TimeTrackerSnapshot } from "../../types/bindings/TimeTrackerSnapshot";

vi.mock("../../i18n-lite", () => ({
  useT: () => (text: string, vars?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? `{${key}}`))
}));
const data = vi.hoisted(() => ({ snapshot: null as TimeTrackerSnapshot | null }));
vi.mock("../../lib/use-time-tracker", () => ({ useTimeTracker: () => data.snapshot }));
const persistence = vi.hoisted(() => ({
  load: vi.fn(),
  write: vi.fn(),
  continueActivity: vi.fn(),
  configure: vi.fn(),
  saveCategory: vi.fn()
}));
vi.mock("../../lib/persistence/time-tracker", () => ({ timeTrackerPersistence: persistence }));
vi.mock("../../components/WidgetSelect", () => ({
  WidgetSelect: ({
    value,
    onChange,
    options,
    ariaLabel
  }: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
    ariaLabel: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../../components/PromptDialog", () => ({ confirmDialog: confirm }));
import { TimeTrackerSettings } from "./TimeTrackerSettings";
import { useTimeTrackerStore } from "../../store/time-tracker-store";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  data.snapshot = {
    config: { ...DEFAULT_TIME_CONFIG },
    categories: [
      { id: "coding", name: "编程", color: "#8b5cf6", builtin: true, archived: false },
      { id: "custom", name: "绘画", color: "#14b8a6", builtin: false, archived: false }
    ],
    blocks: [],
    latest: null,
    continuous_start_ms: null,
    pending: null,
    next: null
  };
  useTimeTrackerStore.setState({ days: {}, loading: false, saving: false, error: null, revision: 0 });
  persistence.configure.mockResolvedValue(undefined);
  persistence.saveCategory.mockResolvedValue(undefined);
  confirm.mockResolvedValue(true);
});

describe("Time Tracker global settings", () => {
  it("offers exactly six reminder intervals and persists fifty minutes", async () => {
    render(<TimeTrackerSettings />);
    expect(screen.getAllByRole("option")).toHaveLength(6);
    fireEvent.change(screen.getByLabelText("提醒间隔"), { target: { value: "50" } });
    await waitFor(() =>
      expect(persistence.configure).toHaveBeenCalledWith({ ...DEFAULT_TIME_CONFIG, interval_minutes: 50 })
    );
  });
  it("rejects a non-aligned active boundary before IPC", async () => {
    render(<TimeTrackerSettings />);
    fireEvent.change(screen.getByLabelText("开始提醒时间"), { target: { value: "07:05" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("对齐整 10 分钟");
    expect(persistence.configure).not.toHaveBeenCalled();
  });
  it("retains a failed category draft and reports the database error", async () => {
    persistence.saveCategory.mockRejectedValueOnce(new Error("disk full"));
    render(<TimeTrackerSettings />);
    fireEvent.change(screen.getByLabelText("新活动名称"), { target: { value: "运动" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByLabelText("新活动名称")).toHaveValue("运动");
  });
  it("archives only custom categories with explicit confirmation", async () => {
    render(<TimeTrackerSettings />);
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(persistence.saveCategory).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", archived: true }))
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
