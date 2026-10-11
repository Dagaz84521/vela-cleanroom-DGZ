import { useState } from "react";
import { useT } from "../../i18n-lite";
import { useTimeTrackerStore } from "../../store/time-tracker-store";
import { useTimeTracker } from "../../lib/use-time-tracker";
import { DEFAULT_TIME_CONFIG, REMINDER_INTERVALS, localDateKey } from "../../domain/time-tracker";
import { Toggle } from "../../components/ui/controls";
import { WidgetSelect } from "../../components/WidgetSelect";
import { confirmDialog } from "../../components/PromptDialog";
import type { TimeCategory } from "../../types/bindings/TimeCategory";
import type { TimeTrackerConfig } from "../../types/bindings/TimeTrackerConfig";
import "../../styles/feature-time-tracker.css";

function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function minuteValue(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function TimeTrackerSettings() {
  const tr = useT();
  const snapshot = useTimeTracker(localDateKey(new Date()));
  const saving = useTimeTrackerStore((s) => s.saving);
  const error = useTimeTrackerStore((s) => s.error);
  const config = snapshot?.config ?? DEFAULT_TIME_CONFIG;
  const [validation, setValidation] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  async function configure(patch: Partial<TimeTrackerConfig>) {
    const next = { ...config, ...patch };
    if (
      !Number.isFinite(next.start_minute) ||
      !Number.isFinite(next.end_minute) ||
      next.start_minute % 10 ||
      next.end_minute % 10 ||
      next.start_minute === next.end_minute
    ) {
      setValidation(tr("开始和结束时间须不同，并对齐整 10 分钟。"));
      return;
    }
    setValidation("");
    try {
      await useTimeTrackerStore.getState().configure(next);
    } catch {
      /* Keep committed config. */
    }
  }
  async function addCategory() {
    try {
      await useTimeTrackerStore.getState().saveCategory({
        id: crypto.randomUUID(),
        name: newName.trim(),
        color: newColor,
        builtin: false,
        archived: false
      });
      setNewName("");
    } catch {
      /* Keep the name so a failed write can be retried. */
    }
  }
  return (
    <section className="tt-settings" data-interactive>
      <h3>{tr("提醒设置")}</h3>
      <p className="tt-muted">{tr("提醒与类别由所有时间记录组件共享，删除小组件不会关闭提醒。")}</p>
      <div className="tt-setting-row">
        <span>{tr("启用定时提醒")}</span>
        <Toggle
          on={config.enabled}
          ariaLabel={tr("启用定时提醒")}
          onChange={(enabled) => {
            if (!saving && snapshot) void configure({ enabled });
          }}
        />
      </div>
      <div className="tt-setting-row">
        <span>{tr("提醒间隔")}</span>
        <WidgetSelect
          ariaLabel={tr("提醒间隔")}
          value={String(config.interval_minutes)}
          options={REMINDER_INTERVALS.map((n) => ({ value: String(n), label: tr("{n} 分钟", { n }) }))}
          onChange={(value) => {
            if (!saving && snapshot) void configure({ interval_minutes: Number(value) });
          }}
        />
      </div>
      <label className="tt-setting-row">
        <span>{tr("开始提醒时间")}</span>
        <input
          className="tt-input"
          type="time"
          step={600}
          value={minuteLabel(config.start_minute)}
          disabled={saving || !snapshot}
          onChange={(e) => void configure({ start_minute: minuteValue(e.target.value) })}
        />
      </label>
      <label className="tt-setting-row">
        <span>{tr("结束提醒时间")}</span>
        <input
          className="tt-input"
          type="time"
          step={600}
          value={minuteLabel(config.end_minute)}
          disabled={saving || !snapshot}
          onChange={(e) => void configure({ end_minute: minuteValue(e.target.value) })}
        />
      </label>
      <p className="tt-muted">{tr("结束时间早于开始时间时跨午夜。记录粒度固定为 10 分钟。")}</p>
      {validation && (
        <p role="alert" className="tt-error">
          {validation}
        </p>
      )}
      <h3>{tr("活动类别")}</h3>
      <div className="tt-category-edit-list">
        {snapshot?.categories
          .filter((c) => !c.archived)
          .map((c) => (
            <CategoryEditor key={`${c.id}:${c.name}:${c.color}`} category={c} />
          ))}
      </div>
      <div className="tt-category-editor">
        <input
          className="tt-input"
          aria-label={tr("新活动名称")}
          placeholder={tr("新活动名称")}
          value={newName}
          maxLength={40}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className="tt-color"
          type="color"
          aria-label={tr("类别颜色")}
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
        />
        <button
          type="button"
          className="tt-button"
          disabled={saving || !snapshot || !newName.trim()}
          onClick={() => void addCategory()}
        >
          {tr("添加")}
        </button>
      </div>
      <p className="tt-muted">{tr("删除自定义类别只将其归档，历史记录会保留原类别。")}</p>
      {error && (
        <p role="alert" className="tt-error">
          {tr("操作失败，数据尚未同步：")}
          {error}
        </p>
      )}
    </section>
  );
}

function CategoryEditor({ category }: { category: TimeCategory }) {
  const tr = useT();
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const saving = useTimeTrackerStore((s) => s.saving);
  async function save(archived = false) {
    if (archived && !(await confirmDialog({ title: tr("归档活动类别？"), message: tr("历史时间记录仍会保留。") })))
      return;
    try {
      await useTimeTrackerStore.getState().saveCategory({ ...category, name: name.trim(), color, archived });
    } catch {
      /* Draft remains editable. */
    }
  }
  return (
    <div className="tt-category-editor">
      <input
        className="tt-input"
        aria-label={tr("活动名称")}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="tt-color"
        type="color"
        aria-label={tr("类别颜色")}
        value={color}
        onChange={(e) => setColor(e.target.value)}
      />
      <button
        type="button"
        className="tt-button"
        disabled={saving || !name.trim() || (name === category.name && color === category.color)}
        onClick={() => void save()}
      >
        {tr("保存")}
      </button>
      {!category.builtin && (
        <button type="button" className="tt-button" disabled={saving} onClick={() => void save(true)}>
          {tr("删除")}
        </button>
      )}
    </div>
  );
}
