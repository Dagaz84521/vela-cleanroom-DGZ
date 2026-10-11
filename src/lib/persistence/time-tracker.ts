import type { TimeTrackerPersistence } from "../../ports/time-tracker";
import { invoke, isTauri } from "../tauri";
import { createSerialChain } from "../serial-chain";
import { bumpDbVersion } from "../db-signal";

const writes = createSerialChain();
function desktopInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("Time Tracker requires the Windows desktop app"));
  return invoke<T>(command, args);
}
function write<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return writes.enqueue(async () => {
    const result = await desktopInvoke<T>(command, args);
    bumpDbVersion();
    return result;
  });
}

export const timeTrackerPersistence: TimeTrackerPersistence = {
  load: (fromMs, toMs) => desktopInvoke("time_tracker_load", { fromMs, toMs }),
  configure: (config) => write("time_tracker_configure", { config }),
  write: (starts, categoryId, note, overwrite) => write("time_tracker_write", { starts, categoryId, note, overwrite }),
  continueActivity: (starts) => write("time_tracker_continue", { starts }),
  saveCategory: (category) => write("time_tracker_save_category", { category })
};
