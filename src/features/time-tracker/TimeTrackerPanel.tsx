import { useMemo, useState } from "react";
import { useT } from "../../i18n-lite";
import { useNow } from "../../lib/use-now";
import { useTimeTracker } from "../../lib/use-time-tracker";
import { useTimeTrackerStore } from "../../store/time-tracker-store";
import {
  clockLabel,
  completedStarts,
  localDateKey,
  mergeBlocks,
  offsetLabel,
  quickRange,
  timelineBlocks
} from "../../domain/time-tracker";
import { DatePicker } from "../../components/DatePicker";
import { TimeRecordForm } from "./TimeRecordForm";
import { TimeTrackerSettings } from "./TimeTrackerSettings";
import "../../styles/feature-time-tracker.css";

export function TimeTrackerPanel({ active = true }: { active?: boolean }) {
  const tr = useT();
  const now = useNow(30_000, active).getTime();
  const [day, setDay] = useState(() => localDateKey(new Date(now)));
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const snapshot = useTimeTracker(day, active);
  const selectionEndDay = selected.length ? localDateKey(new Date(selected.at(-1)!)) : day;
  const endSnapshot = useTimeTracker(selectionEndDay, active && selectionEndDay !== day);
  const selectionReady = !!snapshot && (selectionEndDay === day || !!endSnapshot);
  const selectionRecords =
    selectionEndDay === day ? (snapshot?.blocks ?? []) : [...(snapshot?.blocks ?? []), ...(endSnapshot?.blocks ?? [])];
  const loading = useTimeTrackerStore((s) => s.loading);
  const error = useTimeTrackerStore((s) => s.error);
  const blocks = useMemo(() => timelineBlocks(day, snapshot?.blocks ?? [], now), [day, snapshot?.blocks, now]);
  const categories = snapshot?.categories ?? [];
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const summary = useMemo(() => mergeBlocks(blocks.filter((b) => b.record)), [blocks]);
  const hours: (typeof blocks)[] = [];
  for (const block of blocks) {
    const last = hours.at(-1);
    const d = new Date(block.start_ms);
    const prev = last?.[0];
    if (
      last &&
      prev &&
      new Date(prev.start_ms).getHours() === d.getHours() &&
      prev.offset_minutes === block.offset_minutes
    )
      last.push(block);
    else hours.push([block]);
  }
  function select(start: number, shift: boolean) {
    if (shift && anchor !== null) {
      const lo = Math.min(anchor, start),
        hi = Math.max(anchor, start);
      setSelected(blocks.filter((b) => b.complete && b.start_ms >= lo && b.start_ms <= hi).map((b) => b.start_ms));
    } else {
      setSelected((old) =>
        old.includes(start) ? old.filter((n) => n !== start) : [...old, start].sort((a, b) => a - b)
      );
      setAnchor(start);
    }
  }
  function selectQuick() {
    if (!snapshot) return;
    const range = quickRange(Date.now(), snapshot.config, snapshot.pending);
    setDay(localDateKey(new Date(range.start_ms)));
    setSelected(completedStarts(range, Date.now()));
    setAnchor(null);
  }
  return (
    <section className="tt-panel" data-interactive aria-label={tr("每日时间轴")}>
      <header className="tt-panel-head">
        <div>
          <h2>{tr("时间记录")}</h2>
          <p className="tt-muted">{tr("每格 10 分钟，空白表示未记录。")}</p>
        </div>
        <button
          type="button"
          className="tt-button"
          onClick={() => setShowSettings((value) => !value)}
          aria-expanded={showSettings}
        >
          {tr("提醒与活动设置")}
        </button>
      </header>
      {showSettings ? (
        <TimeTrackerSettings />
      ) : (
        <>
          <div className="tt-toolbar">
            <DatePicker
              value={day}
              ariaLabel={tr("选择日期")}
              onChange={(value) => {
                if (value) {
                  setDay(value);
                  setSelected([]);
                  setAnchor(null);
                }
              }}
            />
            <button type="button" className="tt-button" onClick={selectQuick} disabled={!snapshot}>
              {tr("记录最近提醒")}
            </button>
            <button
              type="button"
              className="tt-button"
              onClick={() => setSelected(blocks.filter((b) => b.complete && !b.record).map((b) => b.start_ms))}
            >
              {tr("选择未记录时段")}
            </button>
            <button
              type="button"
              className="tt-button"
              onClick={() => {
                setSelected([]);
                setAnchor(null);
              }}
            >
              {tr("清除选择")}
            </button>
          </div>
          <p className="tt-muted">{tr("点击时间块选择，Shift 点击可选连续时段。未来时段不可记录。")}</p>
          <div className="tt-legend">
            {categories
              .filter((c) => !c.archived || snapshot?.blocks.some((b) => b.category_id === c.id))
              .map((c) => (
                <span key={c.id}>
                  <i className="tt-dot" style={{ background: c.color }} />
                  {c.builtin ? tr(c.name) : c.name}
                </span>
              ))}
            <span>
              <i className="tt-dot empty" />
              {tr("未记录")}
            </span>
          </div>
          {selected.length > 0 && snapshot && selectionReady && (
            <div className="tt-selection">
              <h3>{tr("已选择 {n} 个时间块", { n: selected.length })}</h3>
              <p className="tt-muted">
                {localDateKey(new Date(selected[0]))} {clockLabel(selected[0])}–{clockLabel(selected.at(-1)! + 600_000)}{" "}
                · {tr("共 {n} 分钟", { n: selected.length * 10 })}
              </p>
              <TimeRecordForm
                key={selected.join(",")}
                starts={selected}
                categories={categories}
                records={selectionRecords}
              />
            </div>
          )}
          <div className="tt-timeline-wrap">
            <div className="tt-timeline" aria-label={tr("每日时间轴")}>
              {hours.map((hour) => (
                <div className="tt-hour" key={hour[0].start_ms}>
                  <span className="tt-hour-label" title={offsetLabel(hour[0].offset_minutes)}>
                    {clockLabel(hour[0].start_ms)}
                    <small>{offsetLabel(hour[0].offset_minutes)}</small>
                  </span>
                  <div className="tt-hour-blocks">
                    {hour.map((block) => {
                      const category = block.record ? categoryMap.get(block.record.category_id) : undefined;
                      const activity = category ? (category.builtin ? tr(category.name) : category.name) : tr("未记录");
                      const label = `${clockLabel(block.start_ms)}–${clockLabel(block.end_ms)} · ${activity} · ${offsetLabel(block.record?.utc_offset_minutes ?? block.offset_minutes)}${block.record?.note ? ` · ${block.record.note}` : ""}`;
                      return (
                        <button
                          type="button"
                          key={block.start_ms}
                          className={`tt-time-block${selected.includes(block.start_ms) ? " selected" : ""}${!block.complete ? " future" : ""}`}
                          style={{
                            borderLeftColor: category?.color,
                            backgroundColor: category
                              ? `color-mix(in srgb, ${category.color} 25%, var(--paper))`
                              : undefined
                          }}
                          title={label}
                          aria-label={label}
                          aria-pressed={selected.includes(block.start_ms)}
                          disabled={!block.complete || !snapshot}
                          onClick={(e) => select(block.start_ms, e.shiftKey)}
                        >
                          <span>{new Date(block.start_ms).getMinutes().toString().padStart(2, "0")}</span>
                          <small>{activity}</small>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {loading && (
              <div className="tt-busy" role="status" aria-label={tr("正在加载")}>
                {tr("正在加载")}
              </div>
            )}
          </div>
          {summary.length > 0 && (
            <div className="tt-summary" aria-label={tr("连续活动摘要")}>
              {summary.map((item) => {
                const cat = categoryMap.get(item.category_id ?? "");
                return (
                  <div key={item.start_ms}>
                    <span className="tt-dot" style={{ background: cat?.color }} />
                    <span>
                      {clockLabel(item.start_ms)}–{clockLabel(item.end_ms)}
                    </span>
                    <b>{cat?.builtin ? tr(cat.name) : cat?.name}</b>
                    <span>{tr("共 {n} 分钟", { n: item.count * 10 })}</span>
                    {item.note && <small>{item.note}</small>}
                  </div>
                );
              })}
            </div>
          )}
          {error && (
            <p role="alert" className="tt-error">
              {tr("操作失败，数据尚未同步：")}
              {error}
              <button type="button" className="tt-button" onClick={() => void useTimeTrackerStore.getState().load(day)}>
                {tr("重试")}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
