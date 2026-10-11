import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n-lite";
import { clockLabel, offsetLabel, timelineBlocks, type TimelineBlock } from "../../domain/time-tracker";
import type { TimeBlock } from "../../types/bindings/TimeBlock";
import type { TimeCategory } from "../../types/bindings/TimeCategory";

export function TimeTrackerMiniTimeline({
  day,
  records,
  categories,
  now,
  visible,
  onOpen,
  onLocateNow,
  locateRequestedAt
}: {
  day: string;
  records: TimeBlock[];
  categories: TimeCategory[];
  now: number;
  visible: boolean;
  onOpen: (block: TimelineBlock) => void;
  onLocateNow?: () => void;
  locateRequestedAt?: number;
}) {
  const tr = useT();
  const blocks = useMemo(() => timelineBlocks(day, records, now), [day, records, now]);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef(0);
  const locatedDay = useRef("");
  const wasVisible = useRef(false);
  const pendingLocate = useRef(false);
  const handledLocate = useRef<number | undefined>(undefined);
  const [selected, setSelected] = useState<number | null>(null);
  const hours: TimelineBlock[][] = [];
  for (const block of blocks) {
    const last = hours.at(-1);
    // Repeated local hours get separate rows, distinguished by UTC offset.
    if (
      last &&
      new Date(last[0].start_ms).getHours() === new Date(block.start_ms).getHours() &&
      last[0].offset_minutes === block.offset_minutes
    )
      last.push(block);
    else hours.push([block]);
  }
  const repeatedHours = new Set(
    hours
      .filter((row, i) =>
        hours.some(
          (other, j) => i !== j && new Date(row[0].start_ms).getHours() === new Date(other[0].start_ms).getHours()
        )
      )
      .map((row) => new Date(row[0].start_ms).getHours())
  );
  const locate = useCallback(
    (time: number, select = false) => {
      const viewport = scroll.current;
      const block = blocks.find((b) => b.start_ms <= time && b.end_ms > time);
      const target = block && viewport?.querySelector<HTMLElement>(`[data-start-ms="${block.start_ms}"]`);
      if (!viewport || !block || !target) return false;
      if (select) setSelected(block.start_ms);
      if (!viewport.clientHeight) return false;
      const bounds = viewport.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      // Both rectangles use viewport coordinates. Convert back to layout pixels
      // before scrolling, including any canvas scale and the container border.
      const scale = viewport.offsetHeight ? bounds.height / viewport.offsetHeight : 1;
      if (scale <= 0) return false;
      const top = viewport.scrollTop + (targetBounds.top - bounds.top) / scale - viewport.clientTop;
      const centered = top - (viewport.clientHeight - targetBounds.height / scale) / 2;
      viewport.scrollTop = Math.max(0, Math.min(centered, viewport.scrollHeight - viewport.clientHeight));
      position.current = viewport.scrollTop;
      return true;
    },
    [blocks]
  );
  useLayoutEffect(() => {
    if (!visible || !scroll.current) {
      wasVisible.current = false;
      return;
    }
    const newRequest = locateRequestedAt !== undefined && handledLocate.current !== locateRequestedAt;
    if (newRequest || pendingLocate.current) {
      pendingLocate.current = !locate(newRequest ? locateRequestedAt : now, true);
      handledLocate.current = locateRequestedAt;
      locatedDay.current = day;
    } else if (locatedDay.current !== day) {
      locatedDay.current = day;
      locate(now);
    } else if (!wasVisible.current) scroll.current.scrollTop = position.current;
    wasVisible.current = true;
  }, [visible, day, now, locate, locateRequestedAt]);
  const label = (block: TimelineBlock) => {
    const category = categories.find((c) => c.id === block.record?.category_id);
    const activity = category
      ? category.builtin
        ? tr(category.name)
        : category.name
      : tr(block.complete ? "未记录" : "未结束");
    return `${clockLabel(block.start_ms)}–${clockLabel(block.end_ms)} · ${activity}${block.record?.note ? ` · ${block.record.note}` : ""} · ${offsetLabel(block.offset_minutes)}`;
  };
  const detail = blocks.find((b) => b.start_ms === selected);
  return (
    <>
      <section className="tt-mini-day" aria-label={tr("今日记录")}>
        <div className="tt-mini-heading">
          <strong>{tr("今日记录")}</strong>
          <span>{day}</span>
          <button
            className="tt-button"
            type="button"
            onClick={() => {
              pendingLocate.current = !locate(Date.now(), true);
              onLocateNow?.();
            }}
          >
            {tr("定位当前")}
          </button>
        </div>
        <div className="tt-mini-columns" aria-hidden="true">
          <span />
          {["00", "10", "20", "30", "40", "50"].map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
        <div
          ref={scroll}
          className="tt-mini-scroll"
          role="region"
          aria-label={tr("今日时间块，可用鼠标滚轮滚动")}
          tabIndex={0}
          onScroll={() => {
            position.current = scroll.current?.scrollTop ?? 0;
          }}
        >
          {hours.map((row) => {
            const first = row[0],
              hour = new Date(first.start_ms).getHours();
            return (
              <div
                className="tt-mini-hour"
                key={first.start_ms}
                data-current={row.some((b) => b.start_ms <= now && b.end_ms > now) || undefined}
              >
                <span className="tt-mini-hour-label">
                  {String(hour).padStart(2, "0")}
                  {repeatedHours.has(hour) && <small>{offsetLabel(first.offset_minutes)}</small>}
                </span>
                <div className="tt-mini-tiles">
                  {row.map((block) => {
                    const category = categories.find((c) => c.id === block.record?.category_id);
                    return (
                      <button
                        type="button"
                        key={block.start_ms}
                        data-start-ms={block.start_ms}
                        className={`tt-mini-tile${!block.complete ? " future" : ""}${block.start_ms <= now && block.end_ms > now ? " current" : ""}`}
                        style={category ? { background: category.color } : undefined}
                        title={label(block)}
                        aria-label={label(block)}
                        aria-pressed={block.start_ms === selected}
                        onClick={() => setSelected(block.start_ms)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (block.complete) onOpen(block);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (block.complete) onOpen(block);
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="tt-mini-count tt-muted">
          {tr("已记录 {n} / 已结束 {s} 块", {
            n: blocks.filter((b) => b.record).length,
            s: blocks.filter((b) => b.complete).length
          })}
        </p>
      </section>
      <p className="tt-mini-detail tt-muted" aria-live="polite">
        {detail ? label(detail) : tr("每格 10 分钟 · 单击看详情，双击修改或补记")}
      </p>
    </>
  );
}
