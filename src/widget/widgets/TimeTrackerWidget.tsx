import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Timer } from "lucide-react";
import { useT } from "../../i18n-lite";
import { useNow } from "../../lib/use-now";
import { useTimeTracker } from "../../lib/use-time-tracker";
import { useTimeTrackerStore } from "../../store/time-tracker-store";
import { clockLabel, completedStarts, localDateKey, nextReminder, quickRange } from "../../domain/time-tracker";
import type { TimeRange } from "../../types/bindings/TimeRange";
import { useWidgetExpand } from "../expand-store";
import { useWidgetStore } from "../widget-store";
import { useWidgetConfig } from "../widget-config";
import { TimeRecordForm, type TimeRecordDraft } from "../../features/time-tracker/TimeRecordForm";
import { TimeTrackerMiniTimeline } from "../../features/time-tracker/TimeTrackerMiniTimeline";
import "../../styles/feature-time-tracker.css";

type RecordSession = { range: TimeRange; starts: number[]; kind: "quick" | "edit" | "backfill"; key: string };

export function TimeTrackerWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const tick = useNow().getTime();
  const [manualClock, setManualClock] = useState<{ tick: number; now: number } | null>(null);
  // A locate click refreshes immediately; the next shared tick resumes ownership,
  // including when the system clock moves backwards.
  const now = manualClock?.tick === tick ? manualClock.now : tick;
  const day = localDateKey(new Date(now));
  const snapshot = useTimeTracker(day);
  const { config } = useWidgetConfig(instanceId);
  const [session, setSession] = useState<RecordSession | null>(null);
  const [message, setMessage] = useState("");
  const drafts = useRef(new Map<string, TimeRecordDraft>());
  const opener = useRef<HTMLElement | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const loading = useTimeTrackerStore((s) => s.loading);
  const saving = useTimeTrackerStore((s) => s.saving);
  const error = useTimeTrackerStore((s) => s.error);
  const startDay = session ? localDateKey(new Date(session.range.start_ms)) : day;
  const endDay = session ? localDateKey(new Date(session.range.end_ms - 1)) : day;
  const startSnapshot = useTimeTracker(startDay, !!session && startDay !== day);
  const endSnapshot = useTimeTracker(endDay, !!session && endDay !== day && endDay !== startDay);
  const records =
    startDay === endDay
      ? (startSnapshot?.blocks ?? [])
      : [...(startSnapshot?.blocks ?? []), ...(endSnapshot?.blocks ?? [])];
  const previous = session
    ? [...records, ...(snapshot?.latest ? [snapshot.latest] : [])]
        .filter((b) => b.end_ms <= session.range.start_ms)
        .sort((a, b) => b.end_ms - a.end_ms)[0]
    : undefined;
  const recent = snapshot?.latest;
  const category = snapshot?.categories.find((c) => c.id === recent?.category_id);
  const next = snapshot ? nextReminder(Date.now(), snapshot.config) : null;
  const continuousMinutes = recent ? (recent.end_ms - (snapshot?.continuous_start_ms ?? recent.start_ms)) / 60_000 : 0;

  useEffect(() => {
    // Upgrade undersized legacy instances through the normal persistence/sync API.
    const state = useWidgetStore.getState();
    const instance = state.instances.find((i) => i.id === instanceId);
    if (instance && (instance.w < 280 || instance.h < 450))
      state.updateWidget(instanceId, { w: Math.max(instance.w, 280), h: Math.max(instance.h, 450) });
  }, [instanceId]);
  useLayoutEffect(() => {
    if (session) back.current?.focus();
    else if (returnFocus.current) {
      opener.current?.focus({ preventScroll: true });
      returnFocus.current = false;
    }
  }, [session]);
  function open(range: TimeRange, kind: RecordSession["kind"]) {
    const starts = completedStarts(range, Date.now());
    if (!starts.length || saving) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessage("");
    setSession({ range, starts, kind, key: `${kind}:${range.start_ms}:${range.end_ms}` });
  }
  function close() {
    returnFocus.current = true;
    setSession(null);
  }
  return (
    <div
      className="tt-widget"
      data-interactive
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing && session && !saving) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="tt-widget-head">
        <Timer size={18} />
        <strong>{tr("时间记录")}</strong>
        <span>{tr("{n} 分钟", { n: snapshot?.config.interval_minutes ?? 10 })}</span>
      </div>
      <div className="tt-widget-overview" hidden={!!session}>
        <div className="tt-current">
          <span className="tt-muted">{tr("最近记录的活动")}</span>
          <b>
            <span className="tt-dot" style={category ? { background: category.color } : undefined} />{" "}
            {category ? (category.builtin ? tr(category.name) : category.name) : tr("未记录")}
          </b>
          <span>{tr("已连续记录 {n} 分钟", { n: continuousMinutes })}</span>
        </div>
        <p className="tt-next">
          {tr("下次提醒")}: {next ? clockLabel(next.end_ms) : tr("提醒已关闭")}
        </p>
        {config.showRecent !== false && recent && (
          <p className="tt-mini-recent tt-muted" title={recent.note}>
            {localDateKey(new Date(recent.start_ms))} {clockLabel(recent.start_ms)}–{clockLabel(recent.end_ms)}
            {recent.note ? ` · ${recent.note}` : ""}
          </p>
        )}
        {snapshot && (
          <TimeTrackerMiniTimeline
            day={day}
            records={snapshot.blocks}
            categories={snapshot.categories}
            now={now}
            visible={!session}
            onLocateNow={() => setManualClock({ tick, now: Date.now() })}
            locateRequestedAt={manualClock?.tick === tick ? manualClock.now : undefined}
            onOpen={(block) => open(block, block.record ? "edit" : "backfill")}
          />
        )}
        {message && (
          <p className="tt-message" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="tt-error" role="alert">
            {tr("操作失败，数据尚未同步：")}
            {error}
            <button className="tt-button" type="button" onClick={() => void useTimeTrackerStore.getState().load(day)}>
              {tr("重试")}
            </button>
          </p>
        )}
        <div className="tt-actions tt-widget-actions">
          <button
            type="button"
            className="tt-button primary"
            disabled={!snapshot}
            onClick={() => {
              if (snapshot) open(quickRange(Date.now(), snapshot.config, snapshot.pending), "quick");
            }}
          >
            {tr("快速记录")}
          </button>
          <button type="button" className="tt-button" onClick={() => useWidgetExpand.getState().expand(instanceId)}>
            {tr("每日时间轴")}
          </button>
        </div>
      </div>
      {session && snapshot && (
        <div
          className="tt-widget-entry"
          aria-label={tr(session.kind === "edit" ? "修改记录" : session.kind === "backfill" ? "补记活动" : "快速记录")}
        >
          <div className="tt-widget-nav">
            <button ref={back} type="button" className="tt-button" disabled={saving} onClick={close}>
              <ArrowLeft size={14} />
              {tr("返回概览")}
            </button>
            <strong>
              {tr(session.kind === "edit" ? "修改记录" : session.kind === "backfill" ? "补记活动" : "快速记录")}
            </strong>
          </div>
          <div className="tt-widget-range">
            <span className="tt-muted">
              {startDay}
              {endDay !== startDay ? ` – ${endDay}` : ""} · {tr("已选择 {n} 个时间块", { n: session.starts.length })}
            </span>
            <b>
              {clockLabel(session.range.start_ms)}–{clockLabel(session.range.end_ms)}
            </b>
          </div>
          <TimeRecordForm
            key={session.key}
            starts={session.starts}
            categories={snapshot.categories}
            records={records}
            compact={{
              editing: session.kind === "edit",
              draft: drafts.current.get(session.key),
              previous,
              onDraftChange: (draft) => {
                drafts.current.set(session.key, draft);
                if (drafts.current.size > 8) drafts.current.delete(drafts.current.keys().next().value!);
              }
            }}
            onSaved={(result) => {
              drafts.current.delete(session.key);
              setMessage(tr("已记录 {n} 块，跳过 {s} 块", { n: result.written, s: result.skipped }));
              close();
            }}
          />
        </div>
      )}
      {loading && !snapshot && (
        <div className="tt-busy" role="status" aria-label={tr("正在加载")}>
          {tr("正在加载")}
        </div>
      )}
    </div>
  );
}
