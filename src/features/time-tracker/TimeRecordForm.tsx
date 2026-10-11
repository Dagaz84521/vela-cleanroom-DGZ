import { useState } from "react";
import { useT } from "../../i18n-lite";
import { useTimeTrackerStore } from "../../store/time-tracker-store";
import { confirmDialog } from "../../components/PromptDialog";
import type { TimeBlock } from "../../types/bindings/TimeBlock";
import type { TimeCategory } from "../../types/bindings/TimeCategory";
import type { TimeWriteResult } from "../../types/bindings/TimeWriteResult";

export type TimeRecordDraft = { categoryId: string; note: string };

export function TimeRecordForm({
  starts,
  categories,
  records,
  instant = false,
  onSaved,
  compact
}: {
  starts: number[];
  categories: TimeCategory[];
  records: TimeBlock[];
  instant?: boolean;
  onSaved?: (result: TimeWriteResult) => void;
  compact?: {
    editing: boolean;
    draft?: TimeRecordDraft;
    previous?: TimeBlock;
    onDraftChange: (draft: TimeRecordDraft) => void;
  };
}) {
  const tr = useT();
  const initial = starts.length === 1 ? records.find((r) => r.start_ms === starts[0]) : undefined;
  const [categoryId, setCategoryId] = useState(compact?.draft?.categoryId ?? initial?.category_id ?? "");
  const [note, setNote] = useState(compact?.draft?.note ?? initial?.note ?? "");
  const [message, setMessage] = useState("");
  const saving = useTimeTrackerStore((s) => s.saving);
  const error = useTimeTrackerStore((s) => s.error);
  const available = categories.filter((c) => !c.archived);
  const existing = records.filter((r) => starts.includes(r.start_ms)).length;

  function changeDraft(id: string, text: string) {
    setCategoryId(id);
    setNote(text);
    compact?.onDraftChange({ categoryId: id, note: text });
  }

  async function save(id: string, replace = false) {
    if (!id || !starts.length) return;
    if (
      replace &&
      existing &&
      !(compact?.editing && starts.length === 1) &&
      !(await confirmDialog({
        title: tr("覆盖已有时间记录？"),
        message: tr("将修改 {n} 个已记录时间块，其余历史保持不变。", { n: existing }),
        confirmLabel: tr("确认覆盖")
      }))
    )
      return;
    setMessage("");
    try {
      const result = await useTimeTrackerStore.getState().record(starts, id, note, replace);
      setMessage(tr("已记录 {n} 块，跳过 {s} 块", { n: result.written, s: result.skipped }));
      onSaved?.(result);
    } catch {
      /* The store exposes the actual persistence error; retain the draft. */
    }
  }
  async function continueActivity() {
    if (compact?.editing) {
      if (compact.previous) changeDraft(compact.previous.category_id, compact.previous.note);
      return;
    }
    setMessage("");
    try {
      const result = await useTimeTrackerStore.getState().continueActivity(starts);
      setMessage(tr("已记录 {n} 块，跳过 {s} 块", { n: result.written, s: result.skipped }));
      onSaved?.(result);
    } catch {
      /* Retain selection after a rejected write. */
    }
  }
  return (
    <div className={`tt-record${compact ? " tt-record-compact" : ""}`} data-interactive>
      <label className="tt-note-label">
        <span>{tr("备注（可选）")}</span>
        <input
          className="tt-input"
          value={note}
          maxLength={1000}
          disabled={saving}
          onChange={(e) => changeDraft(categoryId, e.target.value)}
          placeholder={tr("记录一点细节")}
        />
      </label>
      <div className="tt-categories" aria-label={tr("活动类别")}>
        {available.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`tt-category${categoryId === c.id ? " selected" : ""}`}
            style={{ borderColor: c.color }}
            aria-pressed={categoryId === c.id}
            disabled={saving || !starts.length}
            onClick={() => {
              changeDraft(c.id, note);
              if (instant) void save(c.id);
            }}
          >
            <span className="tt-dot" style={{ background: c.color }} />
            {c.builtin ? tr(c.name) : c.name}
          </button>
        ))}
      </div>
      <div className="tt-actions">
        <button
          type="button"
          className="tt-button"
          disabled={saving || !starts.length || (compact?.editing && !compact.previous)}
          onClick={() => void continueActivity()}
        >
          {tr("延续上一活动")}
        </button>
        {compact?.editing && <p className="tt-muted">{tr("只修改这个 10 分钟时间块。")}</p>}
        {!instant && (
          <button
            type="button"
            className="tt-button primary"
            disabled={saving || !categoryId || !starts.length || !available.some((c) => c.id === categoryId)}
            onClick={() => void save(categoryId, compact ? compact.editing : starts.length === 1 && existing === 1)}
          >
            {compact?.editing ? tr("保存修改") : tr("确认记录")}
          </button>
        )}
        {!compact && !instant && starts.length > 1 && existing > 0 && (
          <button
            type="button"
            className="tt-button"
            disabled={saving || !categoryId}
            onClick={() => void save(categoryId, true)}
          >
            {tr("覆盖已选记录")}
          </button>
        )}
      </div>
      {existing > 0 && starts.length > 1 && <p className="tt-muted">{tr("默认跳过已有记录；覆盖需要确认。")}</p>}
      {message && (
        <p role="status" className="tt-message">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="tt-error">
          {tr("操作失败，数据尚未同步：")}
          {error}
        </p>
      )}
    </div>
  );
}
