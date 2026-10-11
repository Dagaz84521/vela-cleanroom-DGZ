import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimeTrackerMiniTimeline } from "./TimeTrackerMiniTimeline";

vi.mock("../../i18n-lite", () => ({ useT: () => (text: string) => text }));
const at = (hour: number, minute: number) => new Date(2026, 9, 10, hour, minute).getTime();
const props = { day: "2026-10-10", records: [], categories: [], now: at(10, 35), visible: true, onOpen: vi.fn() };

function geometry(container: HTMLElement, height = 120, scale = 1) {
  const viewport = screen.getByRole("region", { name: "今日时间块，可用鼠标滚轮滚动" });
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: height },
    clientTop: { configurable: true, value: 2 },
    offsetHeight: { configurable: true, value: height + 4 },
    scrollHeight: { configurable: true, value: 580 },
    // Reproduce the original mismatch: rows are relative to the scroll region,
    // while the region itself is positioned relative to the outer widget.
    offsetTop: { configurable: true, value: 180 }
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
    () => ({ top: 200, height: (height + 4) * scale }) as DOMRect
  );
  for (const [index, row] of [...container.querySelectorAll<HTMLElement>(".tt-mini-hour")].entries()) {
    Object.defineProperty(row, "offsetTop", { configurable: true, value: index * 24 });
    for (const tile of row.querySelectorAll<HTMLElement>(".tt-mini-tile")) {
      vi.spyOn(tile, "getBoundingClientRect").mockImplementation(
        () => ({ top: 200 + (2 + index * 24 - viewport.scrollTop) * scale, height: 20 * scale }) as DOMRect
      );
    }
  }
  return viewport;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(at(10, 35));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("locate current time block", () => {
  it.each([1, 0.5, 2])("centers the exact ten-minute tile at canvas scale %s from any scroll position", (scale) => {
    const { container } = render(<TimeTrackerMiniTimeline {...props} />);
    const viewport = geometry(container, 120, scale);
    viewport.scrollTop = 80;
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(viewport.scrollTop).toBeCloseTo(190);
    expect(screen.getByRole("button", { name: /10:30–10:40/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(viewport.scrollTop).toBeCloseTo(190);
    viewport.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(viewport.scrollTop).toBeCloseTo(190);
  });
  it("uses the click's actual time rather than the stale display tick", () => {
    const onLocateNow = vi.fn();
    const { container } = render(<TimeTrackerMiniTimeline {...props} onLocateNow={onLocateNow} />);
    geometry(container);
    vi.mocked(Date.now).mockReturnValue(at(11, 1));
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(screen.getByRole("button", { name: /11:00–11:10/ })).toHaveAttribute("aria-pressed", "true");
    expect(onLocateNow).toHaveBeenCalledOnce();
  });
  it("recalculates centering after resize and preserves it after switching pages", () => {
    const { container, rerender } = render(<TimeTrackerMiniTimeline {...props} />);
    const viewport = geometry(container, 240);
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(viewport.scrollTop).toBeCloseTo(130);
    rerender(<TimeTrackerMiniTimeline {...props} visible={false} />);
    viewport.scrollTop = 0;
    rerender(<TimeTrackerMiniTimeline {...props} />);
    expect(viewport.scrollTop).toBeCloseTo(130);
  });
  it("does not interrupt manual browsing when the display clock refreshes", () => {
    const { container, rerender } = render(<TimeTrackerMiniTimeline {...props} />);
    const viewport = geometry(container);
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    viewport.scrollTop = 112;
    fireEvent.scroll(viewport);
    rerender(<TimeTrackerMiniTimeline {...props} now={at(11, 5)} />);
    expect(viewport.scrollTop).toBe(112);
  });
  it.each([
    [0, 1, 0],
    [23, 59, 460]
  ])("keeps %s:%s within the scroll bounds", (hour, minute, expected) => {
    const { container } = render(<TimeTrackerMiniTimeline {...props} />);
    const viewport = geometry(container);
    vi.mocked(Date.now).mockReturnValue(at(hour, minute));
    fireEvent.click(screen.getByRole("button", { name: "定位当前" }));
    expect(viewport.scrollTop).toBe(expected);
  });
});
