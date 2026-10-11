//! Time Tracker repository and application-owned scheduler. No widget owns a timer.
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

use crate::db::{lock_db, DbError, DbResult};
use crate::models::{
    TimeBlock, TimeCategory, TimeRange, TimeTrackerConfig, TimeTrackerSnapshot, TimeWriteResult,
};
use crate::repositories::{NotificationRepo, SettingsRepo};

pub const BLOCK_MS: i64 = 600_000;
const CONFIG_KEY: &str = "time-tracker:config:v1";
const CURSOR_KEY: &str = "time-tracker:cursor:v1";
const PENDING_KEY: &str = "time-tracker:pending:v1";
pub static OPEN_REQUESTED: AtomicBool = AtomicBool::new(false);

fn invalid(message: &str) -> DbError {
    DbError::Task(message.into())
}

pub fn validate_config(c: &TimeTrackerConfig) -> DbResult<()> {
    if ![10, 20, 30, 40, 50, 60].contains(&c.interval_minutes)
        || c.start_minute >= 1440
        || c.end_minute >= 1440
        || !c.start_minute.is_multiple_of(10)
        || !c.end_minute.is_multiple_of(10)
        || c.start_minute == c.end_minute
    {
        return Err(invalid(
            "Choose an interval and distinct active boundaries aligned to ten minutes",
        ));
    }
    Ok(())
}

/// Resolve a wall-clock boundary. A fold uses its first occurrence; a gap moves
/// forward to the first actual ten-minute boundary. Blocks themselves use instants.
fn boundary<T: TimeZone>(tz: &T, date: NaiveDate, minute: u32) -> Option<DateTime<T>> {
    let wall = date.and_hms_opt(minute / 60, minute % 60, 0)?;
    (0..=180).step_by(10).find_map(|n| {
        tz.from_local_datetime(&(wall + Duration::minutes(n)))
            .earliest()
    })
}

/// Generate reminders from the active start, including a short final tail.
/// Absolute duration handles skipped/repeated local hours without assuming 144 blocks/day.
pub fn ranges<T: TimeZone>(now: &DateTime<T>, c: &TimeTrackerConfig) -> Vec<TimeRange> {
    if validate_config(c).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for offset in -1..=1 {
        let Some(day) = now.date_naive().checked_add_signed(Duration::days(offset)) else {
            continue;
        };
        let end_day = if c.end_minute < c.start_minute {
            day.succ_opt()
        } else {
            Some(day)
        };
        let Some(start) = boundary(&now.timezone(), day, c.start_minute) else {
            continue;
        };
        let Some(end) = end_day.and_then(|d| boundary(&now.timezone(), d, c.end_minute)) else {
            continue;
        };
        let mut cursor = start.timestamp_millis();
        let end = end.timestamp_millis();
        while cursor < end {
            let next = (cursor + i64::from(c.interval_minutes) * 60_000).min(end);
            out.push(TimeRange {
                start_ms: cursor,
                end_ms: next,
            });
            cursor = next;
        }
    }
    out.sort_by_key(|r| r.end_ms);
    out
}

/// Startup, clock reversal, config changes and long suspension never catch up notifications.
pub fn due_range(
    schedule: &[TimeRange],
    previous_ms: i64,
    now_ms: i64,
    claimed_ms: i64,
) -> Option<TimeRange> {
    if now_ms <= previous_ms || now_ms - previous_ms > 90_000 {
        return None;
    }
    schedule
        .iter()
        .rev()
        .find(|r| r.end_ms > previous_ms && r.end_ms <= now_ms && r.end_ms > claimed_ms)
        .map(|r| TimeRange {
            start_ms: r.start_ms.max(claimed_ms),
            end_ms: r.end_ms,
        })
        .filter(|r| r.start_ms < r.end_ms)
}

pub struct TimeTrackerRepo;
impl TimeTrackerRepo {
    pub fn config(conn: &Connection) -> DbResult<TimeTrackerConfig> {
        let config = SettingsRepo::get(conn, CONFIG_KEY)?
            .map(|raw| serde_json::from_str(&raw).map_err(|e| invalid(&e.to_string())))
            .transpose()?
            .unwrap_or_default();
        validate_config(&config)?;
        Ok(config)
    }
    pub fn set_config(conn: &Connection, c: &TimeTrackerConfig) -> DbResult<()> {
        validate_config(c)?;
        SettingsRepo::set(
            conn,
            CONFIG_KEY,
            &serde_json::to_string(c).map_err(|e| invalid(&e.to_string()))?,
        )
    }
    pub fn categories(conn: &Connection) -> DbResult<Vec<TimeCategory>> {
        let mut stmt = conn.prepare("SELECT id, name, color, builtin, archived FROM time_categories ORDER BY builtin DESC, rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok(TimeCategory {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                builtin: r.get(3)?,
                archived: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn save_category(conn: &Connection, category: &TimeCategory) -> DbResult<()> {
        if category.name.trim().is_empty()
            || category.name.chars().count() > 40
            || category.color.len() != 7
            || !category.color.starts_with('#')
            || !category.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid("Invalid category name or color"));
        }
        let existing: Option<bool> = conn
            .query_row(
                "SELECT builtin FROM time_categories WHERE id=?1",
                [&category.id],
                |r| r.get(0),
            )
            .optional()?;
        if category.archived && existing.unwrap_or(false) {
            return Err(invalid("Preset categories cannot be deleted"));
        }
        // Never trust the client to turn a custom category into a preset.
        conn.execute("INSERT INTO time_categories(id,name,color,builtin,archived) VALUES(?1,?2,?3,0,?4)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,archived=excluded.archived",
            params![category.id, category.name.trim(), category.color, category.archived])?;
        Ok(())
    }
    fn block(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimeBlock> {
        Ok(TimeBlock {
            id: row.get(0)?,
            start_ms: row.get(1)?,
            end_ms: row.get(2)?,
            local_date: row.get(3)?,
            utc_offset_minutes: row.get(4)?,
            category_id: row.get(5)?,
            note: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }
    pub fn list(conn: &Connection, from_ms: i64, to_ms: i64) -> DbResult<Vec<TimeBlock>> {
        if from_ms < 0 || to_ms <= from_ms || to_ms.saturating_sub(from_ms) > 3 * 86_400_000 {
            return Err(invalid("Invalid day range"));
        }
        let mut stmt = conn.prepare("SELECT id,start_ms,end_ms,local_date,utc_offset_minutes,category_id,note,created_at,updated_at
            FROM time_blocks WHERE start_ms>=?1 AND start_ms<?2 ORDER BY start_ms")?;
        let rows = stmt.query_map(params![from_ms, to_ms], Self::block)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn latest_before(conn: &Connection, end_ms: i64) -> DbResult<Option<TimeBlock>> {
        Ok(conn.query_row("SELECT id,start_ms,end_ms,local_date,utc_offset_minutes,category_id,note,created_at,updated_at
            FROM time_blocks WHERE end_ms<=?1 ORDER BY start_ms DESC LIMIT 1", [end_ms], Self::block).optional()?)
    }
    pub fn snapshot(
        conn: &Connection,
        from_ms: i64,
        to_ms: i64,
        now: DateTime<Local>,
    ) -> DbResult<TimeTrackerSnapshot> {
        let tx = conn.unchecked_transaction()?; // All fields belong to the same committed snapshot.
        let config = Self::config(&tx)?;
        let categories = Self::categories(&tx)?;
        let blocks = Self::list(&tx, from_ms, to_ms)?;
        let latest = Self::latest_before(&tx, now.timestamp_millis())?;
        let continuous_start_ms = latest
            .as_ref()
            .map(|last| {
                tx.query_row(
                    "WITH RECURSIVE chain(start_ms,category_id,note) AS (
                SELECT start_ms,category_id,note FROM time_blocks WHERE id=?1
                UNION ALL SELECT b.start_ms,b.category_id,b.note FROM time_blocks b JOIN chain c
                    ON b.end_ms=c.start_ms AND b.category_id=c.category_id
                ) SELECT MIN(start_ms) FROM chain",
                    [&last.id],
                    |r| r.get::<_, i64>(0),
                )
            })
            .transpose()?;
        let pending = SettingsRepo::get(&tx, PENDING_KEY)?
            .map(|s| serde_json::from_str(&s).map_err(|e| invalid(&e.to_string())))
            .transpose()?;
        let next = if config.enabled {
            ranges(&now, &config)
                .into_iter()
                .find(|r| r.end_ms > now.timestamp_millis())
        } else {
            None
        };
        tx.commit()?;
        Ok(TimeTrackerSnapshot {
            config,
            categories,
            blocks,
            latest,
            continuous_start_ms,
            pending,
            next,
        })
    }
    /// All validation and writes are atomic. Repeated starts deduplicate; existing
    /// rows are skipped unless the caller has explicitly confirmed replacement.
    pub fn write(
        conn: &Connection,
        starts: &[i64],
        category_id: &str,
        note: &str,
        overwrite: bool,
        now_ms: i64,
    ) -> DbResult<TimeWriteResult> {
        if starts.is_empty() || starts.len() > 300 || note.chars().count() > 1000 {
            return Err(invalid("Invalid block count or note length"));
        }
        let tx = conn.unchecked_transaction()?;
        let active: bool = tx
            .query_row(
                "SELECT archived=0 FROM time_categories WHERE id=?1",
                [category_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !active {
            return Err(invalid("Category is unavailable"));
        }
        let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut result = TimeWriteResult {
            written: 0,
            skipped: 0,
        };
        let unique: std::collections::BTreeSet<_> = starts.iter().copied().collect();
        for start in unique {
            let local = Local
                .timestamp_millis_opt(start)
                .single()
                .ok_or_else(|| invalid("Invalid timestamp"))?;
            let end = start
                .checked_add(BLOCK_MS)
                .ok_or_else(|| invalid("Invalid timestamp"))?;
            if start < 0
                || end > now_ms
                || local.minute() % 10 != 0
                || local.second() != 0
                || local.timestamp_subsec_millis() != 0
            {
                return Err(invalid(
                    "Only completed local ten-minute blocks can be recorded",
                ));
            }
            let sql = if overwrite {
                "INSERT INTO time_blocks(id,start_ms,end_ms,local_date,utc_offset_minutes,category_id,note,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) ON CONFLICT(start_ms) DO UPDATE
                 SET category_id=excluded.category_id,note=excluded.note,updated_at=excluded.updated_at"
            } else {
                "INSERT INTO time_blocks(id,start_ms,end_ms,local_date,utc_offset_minutes,category_id,note,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) ON CONFLICT(start_ms) DO NOTHING"
            };
            let rows = tx.execute(
                sql,
                params![
                    uuid::Uuid::new_v4().to_string(),
                    start,
                    end,
                    local.format("%Y-%m-%d").to_string(),
                    local.offset().local_minus_utc() / 60,
                    category_id,
                    note,
                    stamp
                ],
            )?;
            if rows > 0 {
                result.written += 1
            } else {
                result.skipped += 1
            }
        }
        tx.commit()?;
        Ok(result)
    }
    pub fn cursor(conn: &Connection) -> DbResult<i64> {
        SettingsRepo::get(conn, CURSOR_KEY)?
            .map(|s| s.parse().map_err(|_| invalid("Invalid reminder cursor")))
            .transpose()
            .map(|v| v.unwrap_or(0))
    }
    pub fn set_pending(conn: &Connection, range: &TimeRange) -> DbResult<()> {
        if range.start_ms < 0
            || range.end_ms <= range.start_ms
            || range.end_ms.saturating_sub(range.start_ms) > 3_600_000
        {
            return Err(invalid("Invalid reminder range"));
        }
        SettingsRepo::set(
            conn,
            PENDING_KEY,
            &serde_json::to_string(range).map_err(|e| invalid(&e.to_string()))?,
        )
    }
    /// The durable cursor is shared by every window and survives restarts/clock reversal.
    pub fn claim(conn: &Connection, range: &TimeRange) -> DbResult<bool> {
        let tx = conn.unchecked_transaction()?;
        if Self::cursor(&tx)? >= range.end_ms {
            return Ok(false);
        }
        SettingsRepo::set(&tx, CURSOR_KEY, &range.end_ms.to_string())?;
        Self::set_pending(&tx, range)?;
        tx.commit()?;
        Ok(true)
    }
}

/// Existing Rust settings wake-up machinery provides immediate config changes and
/// a bounded wall-clock recheck for sleep/time-zone/time changes. One worker/process.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut previous = Local::now().timestamp_millis();
        let mut last_config = None;
        loop {
            if crate::ALLOW_EXIT.load(Ordering::SeqCst) {
                return;
            }
            let generation = crate::settings_mirror::generation();
            let now = Local::now();
            let state = app.state::<crate::AppState>();
            let config = state
                .read_db
                .acquire()
                .and_then(|conn| TimeTrackerRepo::config(&conn));
            let mut delay_ms = 30_000;
            match config {
                Ok(config) => {
                    if last_config.as_ref() != Some(&config) {
                        previous = now.timestamp_millis();
                    }
                    if config.enabled {
                        let schedule = ranges(&now, &config);
                        if let Some(next) =
                            schedule.iter().find(|r| r.end_ms > now.timestamp_millis())
                        {
                            delay_ms = (next.end_ms - now.timestamp_millis()).clamp(1, 30_000);
                        }
                        let claimed = state
                            .read_db
                            .acquire()
                            .and_then(|c| TimeTrackerRepo::cursor(&c));
                        if let Ok(claimed) = claimed {
                            if let Some(range) =
                                due_range(&schedule, previous, now.timestamp_millis(), claimed)
                            {
                                let claim = lock_db(&state.db)
                                    .and_then(|c| TimeTrackerRepo::claim(&c, &range));
                                match claim {
                                    Ok(true) => {
                                        let _ = app.emit("sync:time-tracker", ());
                                        deliver_reminder(&app, &range, &now);
                                    }
                                    Err(e) => {
                                        log::error!("time tracker reminder claim failed: {e}")
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    last_config = Some(config);
                }
                Err(e) => log::error!("time tracker config unavailable: {e}"),
            }
            previous = now.timestamp_millis();
            crate::settings_mirror::wait_for_change_since(
                generation,
                std::time::Duration::from_millis(delay_ms as u64),
            );
        }
    });
}

fn deliver_reminder(app: &tauri::AppHandle, range: &TimeRange, now: &DateTime<Local>) {
    let mirror = crate::settings_mirror::read_json(app).unwrap_or_default();
    if mirror
        .pointer("/notifications/sources/time-tracker")
        .and_then(|v| v.as_bool())
        == Some(false)
    {
        return;
    }
    let language = mirror
        .pointer("/general/language")
        .and_then(|v| v.as_str())
        .unwrap_or("简体中文");
    let english = language == "English";
    let minutes = (range.end_ms - range.start_ms) / 60_000;
    let title = if english {
        "Time Tracker"
    } else {
        "时间记录"
    };
    let question = if english {
        format!("What did you do in the past {minutes} minutes?")
    } else {
        format!("过去 {minutes} 分钟，你在做什么？")
    };
    let clock = |ms| {
        Local
            .timestamp_millis_opt(ms)
            .single()
            .map(|d| d.format("%H:%M %:z").to_string())
            .unwrap_or_default()
    };
    let body = format!(
        "{question}\n{} – {}",
        clock(range.start_ms),
        clock(range.end_ms)
    );
    if let Some(state) = app.try_state::<crate::AppState>() {
        let record = lock_db(&state.db)
            .and_then(|c| NotificationRepo::add(&c, "time-tracker", title, &body, Some("info")));
        match record {
            Ok(record) => {
                let _ = app.emit("app:notification", record);
            }
            Err(e) => log::warn!("time tracker notification history failed: {e}"),
        }
    }
    let focus = mirror
        .pointer("/extra/focusMode")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if focus == "medium" || focus == "deep" {
        return;
    }
    // Honor the existing local-storage mirror of manual/scheduled Do Not Disturb.
    if let Some(state) = app.try_state::<crate::AppState>() {
        let dnd = state
            .read_db
            .acquire()
            .ok()
            .and_then(|c| {
                SettingsRepo::get(&c, "lsmirror:focus-desk.dnd.v1")
                    .ok()
                    .flatten()
            })
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_default();
        if dnd.get("on").and_then(|v| v.as_bool()) == Some(true) {
            return;
        }
        let parse = |key: &str| {
            dnd.pointer(key)
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::NaiveTime::parse_from_str(s, "%H:%M").ok())
                .map(|t| t.hour() * 60 + t.minute())
        };
        if dnd.pointer("/sched/enabled").and_then(|v| v.as_bool()) == Some(true) {
            if let (Some(start), Some(end)) = (parse("/sched/start"), parse("/sched/end")) {
                let minute = now.hour() * 60 + now.minute();
                if start == end
                    || (start < end && minute >= start && minute <= end)
                    || (start > end && (minute >= start || minute <= end))
                {
                    return;
                }
            }
        }
    }
    if let Err(e) = crate::os_notify::send_with_activation(
        app.clone(),
        title.to_string(),
        body,
        "time-tracker".into(),
        None,
        serde_json::to_string(range).ok(),
    ) {
        log::warn!("time tracker toast failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, LocalResult, NaiveDateTime};
    fn db() -> Connection {
        crate::db::in_memory(crate::db::MIGRATIONS).unwrap()
    }
    fn at(hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(2026, 10, 10, hour, minute, 0)
            .earliest()
            .unwrap()
            .timestamp_millis()
    }
    fn config(interval: u32) -> TimeTrackerConfig {
        TimeTrackerConfig {
            interval_minutes: interval,
            ..Default::default()
        }
    }

    #[test]
    fn all_six_intervals_fill_the_correct_number_of_blocks() {
        for interval in [10, 20, 30, 40, 50, 60] {
            let now = Local.timestamp_millis_opt(at(7, 0)).unwrap();
            let schedule = ranges(&now, &config(interval));
            let first = schedule.iter().find(|r| r.start_ms == at(7, 0)).unwrap();
            assert_eq!(first.end_ms - first.start_ms, i64::from(interval) * 60_000);
            assert_eq!(
                (first.end_ms - first.start_ms) / BLOCK_MS,
                i64::from(interval / 10)
            );
        }
    }
    #[test]
    fn fifty_minutes_does_not_reset_at_hour_boundary() {
        let schedule = ranges(&Local.timestamp_millis_opt(at(7, 0)).unwrap(), &config(50));
        assert!(schedule
            .iter()
            .any(|r| r.start_ms == at(7, 50) && r.end_ms == at(8, 40)));
        assert!(schedule
            .iter()
            .any(|r| r.end_ms == at(23, 0) && r.start_ms == at(22, 50)));
    }
    #[test]
    fn late_start_sleep_restart_and_reversed_clock_do_not_catch_up() {
        let schedule = ranges(&Local.timestamp_millis_opt(at(10, 7)).unwrap(), &config(10));
        assert!(due_range(&schedule, at(10, 7), at(10, 7), 0).is_none());
        assert!(due_range(&schedule, at(10, 7), at(10, 8), 0).is_none());
        assert!(due_range(&schedule, at(10, 9) + 30_000, at(10, 10), 0).is_some());
        assert!(due_range(&schedule, at(10, 9), at(12, 0), 0).is_none());
        assert!(due_range(&schedule, at(12, 0), at(10, 0), 0).is_none());
        assert!(due_range(&schedule, at(10, 9), at(10, 10), at(10, 10)).is_none());
    }
    #[test]
    fn active_edges_and_overnight_sessions() {
        let now = Local.timestamp_millis_opt(at(7, 0)).unwrap();
        let schedule = ranges(&now, &config(30));
        assert!(!schedule.iter().any(|r| r.end_ms == at(7, 0)));
        assert!(schedule.iter().any(|r| r.end_ms == at(23, 0)));
        let c = TimeTrackerConfig {
            start_minute: 1380,
            end_minute: 60,
            ..config(40)
        };
        let overnight = ranges(&now, &c);
        let midnight = Local
            .with_ymd_and_hms(2026, 10, 11, 0, 20, 0)
            .earliest()
            .unwrap()
            .timestamp_millis();
        assert!(overnight
            .iter()
            .any(|r| r.start_ms == at(23, 40) && r.end_ms == midnight));
        assert!(validate_config(&TimeTrackerConfig {
            start_minute: 421,
            ..config(10)
        })
        .is_err());
    }
    #[test]
    fn changing_interval_preserves_records_and_does_not_repeat_claims() {
        let conn = db();
        TimeTrackerRepo::write(&conn, &[at(10, 0)], "coding", "note", false, at(12, 0)).unwrap();
        TimeTrackerRepo::claim(
            &conn,
            &TimeRange {
                start_ms: at(10, 0),
                end_ms: at(10, 10),
            },
        )
        .unwrap();
        TimeTrackerRepo::set_config(&conn, &config(60)).unwrap();
        assert_eq!(
            TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0))
                .unwrap()
                .len(),
            1
        );
        let s = ranges(
            &Local.timestamp_millis_opt(at(10, 12)).unwrap(),
            &config(60),
        );
        assert_eq!(
            s.iter().find(|r| r.end_ms > at(10, 12)).unwrap().end_ms,
            at(11, 0)
        );
        assert!(due_range(&s, at(10, 12), at(10, 12), at(10, 10)).is_none());
    }
    #[test]
    fn widget_removal_and_multiple_displays_do_not_own_reminder_claims() {
        let conn = db();
        let range = TimeRange {
            start_ms: at(10, 0),
            end_ms: at(10, 10),
        };
        assert!(TimeTrackerRepo::claim(&conn, &range).unwrap());
        for _display in 0..3 {
            assert!(!TimeTrackerRepo::claim(&conn, &range).unwrap());
        }
        // No layout or widget instance is required; the next application tick still works.
        assert!(TimeTrackerRepo::claim(
            &conn,
            &TimeRange {
                start_ms: at(10, 10),
                end_ms: at(10, 20)
            }
        )
        .unwrap());
    }
    #[test]
    fn batch_skip_duplicates_edit_and_reload() {
        let conn = db();
        let starts = [at(10, 0), at(10, 10), at(10, 20)];
        let first =
            TimeTrackerRepo::write(&conn, &starts, "coding", "hello", false, at(12, 0)).unwrap();
        assert_eq!(first.written, 3);
        let old = TimeTrackerRepo::list(&conn, at(10, 0), at(11, 0)).unwrap();
        let duplicate =
            TimeTrackerRepo::write(&conn, &starts, "reading", "", false, at(12, 0)).unwrap();
        assert_eq!(duplicate.skipped, 3);
        assert_eq!(
            TimeTrackerRepo::write(&conn, &[at(10, 10)], "reading", "edited", true, at(12, 0))
                .unwrap()
                .written,
            1
        );
        let new = TimeTrackerRepo::list(&conn, at(10, 0), at(11, 0)).unwrap();
        assert_eq!(new[1].id, old[1].id);
        assert_eq!(new[1].created_at, old[1].created_at);
        assert_eq!(new[1].note, "edited");
        assert_eq!(new[0].category_id, "coding");
    }
    #[test]
    fn continue_previous_activity_and_backfill_without_inference() {
        let conn = db();
        TimeTrackerRepo::write(&conn, &[at(10, 0)], "coding", "same note", false, at(12, 0))
            .unwrap();
        let previous = TimeTrackerRepo::latest_before(&conn, at(11, 0))
            .unwrap()
            .unwrap();
        let starts = [at(11, 0), at(11, 10), at(11, 20), at(11, 30)];
        TimeTrackerRepo::write(
            &conn,
            &starts,
            &previous.category_id,
            &previous.note,
            false,
            at(12, 0),
        )
        .unwrap();
        let blocks = TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0)).unwrap();
        assert_eq!(blocks.len(), 5); // 10:10–11:00 remains blank.
        assert!(blocks.iter().all(|b| b.note == "same note"));
    }
    #[test]
    fn invalid_future_or_sql_failure_rolls_back_the_entire_batch() {
        let conn = db();
        assert!(TimeTrackerRepo::write(
            &conn,
            &[at(10, 0), at(12, 0)],
            "coding",
            "",
            false,
            at(12, 0)
        )
        .is_err());
        assert!(TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0))
            .unwrap()
            .is_empty());
        conn.execute_batch(&format!("CREATE TRIGGER fail_batch BEFORE INSERT ON time_blocks WHEN NEW.start_ms={} BEGIN SELECT RAISE(ABORT,'disk failure'); END",at(10,10))).unwrap();
        assert!(TimeTrackerRepo::write(
            &conn,
            &[at(10, 0), at(10, 10)],
            "coding",
            "",
            false,
            at(12, 0)
        )
        .is_err());
        assert!(TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn archived_categories_preserve_history() {
        let conn = db();
        let mut cat = TimeCategory {
            id: "custom".into(),
            name: "Custom".into(),
            color: "#112233".into(),
            builtin: false,
            archived: false,
        };
        TimeTrackerRepo::save_category(&conn, &cat).unwrap();
        TimeTrackerRepo::write(&conn, &[at(10, 0)], "custom", "", false, at(12, 0)).unwrap();
        cat.archived = true;
        TimeTrackerRepo::save_category(&conn, &cat).unwrap();
        assert_eq!(
            TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0))
                .unwrap()
                .len(),
            1
        );
        assert!(TimeTrackerRepo::categories(&conn)
            .unwrap()
            .iter()
            .any(|c| c.id == "custom" && c.archived));
    }
    #[test]
    fn snapshot_tracks_continuous_category_and_old_toast_range_without_reclaiming() {
        let conn = db();
        TimeTrackerRepo::write(&conn, &[at(10, 0)], "coding", "first", false, at(12, 0)).unwrap();
        TimeTrackerRepo::write(&conn, &[at(10, 10)], "coding", "second", false, at(12, 0)).unwrap();
        let older = TimeRange {
            start_ms: at(10, 0),
            end_ms: at(10, 10),
        };
        let newer = TimeRange {
            start_ms: at(10, 10),
            end_ms: at(10, 20),
        };
        assert!(TimeTrackerRepo::claim(&conn, &newer).unwrap());
        TimeTrackerRepo::set_pending(&conn, &older).unwrap();
        let snapshot = TimeTrackerRepo::snapshot(
            &conn,
            at(0, 0),
            at(23, 50),
            Local.timestamp_millis_opt(at(12, 0)).unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot.continuous_start_ms, Some(at(10, 0)));
        assert_eq!(snapshot.blocks.len(), 2);
        assert_eq!(snapshot.pending.unwrap().end_ms, older.end_ms);
        assert_eq!(TimeTrackerRepo::cursor(&conn).unwrap(), newer.end_ms);
        assert!(!TimeTrackerRepo::claim(&conn, &older).unwrap());
    }
    #[test]
    fn file_database_survives_restart() {
        let path = std::env::temp_dir().join(format!("vela-time-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = crate::db::open_and_migrate(&path, crate::db::MIGRATIONS).unwrap();
            TimeTrackerRepo::set_config(&conn, &config(30)).unwrap();
            TimeTrackerRepo::write(&conn, &[at(10, 0)], "coding", "persisted", false, at(12, 0))
                .unwrap();
        }
        {
            let conn = crate::db::open_and_migrate(&path, crate::db::MIGRATIONS).unwrap();
            assert_eq!(TimeTrackerRepo::config(&conn).unwrap().interval_minutes, 30);
            assert_eq!(
                TimeTrackerRepo::list(&conn, at(10, 0), at(12, 0)).unwrap()[0].note,
                "persisted"
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    /// Deterministic US-style DST zone; no dependency on the test host's zone.
    #[derive(Clone)]
    struct Dst;
    impl TimeZone for Dst {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            Self
        }
        fn offset_from_local_date(&self, date: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, d: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let spring = NaiveDate::from_ymd_opt(2024, 3, 10).unwrap();
            let fall = NaiveDate::from_ymd_opt(2024, 11, 3).unwrap();
            let standard = FixedOffset::west_opt(5 * 3600).unwrap();
            let summer = FixedOffset::west_opt(4 * 3600).unwrap();
            if d.date() == spring && d.hour() == 2 {
                return LocalResult::None;
            }
            if d.date() == fall && d.hour() == 1 {
                return LocalResult::Ambiguous(summer, standard);
            }
            if *d >= spring.and_hms_opt(3, 0, 0).unwrap() && *d < fall.and_hms_opt(1, 0, 0).unwrap()
            {
                LocalResult::Single(summer)
            } else {
                LocalResult::Single(standard)
            }
        }
        fn offset_from_utc_date(&self, date: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, d: &NaiveDateTime) -> FixedOffset {
            let s = NaiveDate::from_ymd_opt(2024, 3, 10)
                .unwrap()
                .and_hms_opt(7, 0, 0)
                .unwrap();
            let f = NaiveDate::from_ymd_opt(2024, 11, 3)
                .unwrap()
                .and_hms_opt(6, 0, 0)
                .unwrap();
            FixedOffset::west_opt(if *d >= s && *d < f {
                4 * 3600
            } else {
                5 * 3600
            })
            .unwrap()
        }
    }
    #[test]
    fn daylight_saving_days_have_138_or_150_real_blocks() {
        let c = TimeTrackerConfig {
            start_minute: 0,
            end_minute: 1430,
            ..config(10)
        };
        for (month, day, expected) in [(3, 10, 137), (11, 3, 149)] {
            let now = Dst.with_ymd_and_hms(2024, month, day, 12, 0, 0).unwrap();
            let schedule = ranges(&now, &c);
            let date = now.date_naive();
            let count = schedule
                .iter()
                .filter(|r| Dst.timestamp_millis_opt(r.start_ms).unwrap().date_naive() == date)
                .count();
            assert_eq!(count, expected); // 23:50 end excludes the final ten-minute block.
            assert!(schedule.iter().all(|r| r.end_ms - r.start_ms == BLOCK_MS));
        }
    }
}
