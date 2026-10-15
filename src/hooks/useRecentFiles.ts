import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'hex-viewer-recent-v1';
/** 最多记住的文件数 */
const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  /** 打开时刻（unix 毫秒），用于展示与排序 */
  time: number;
}

function isRecentFile(v: unknown): v is RecentFile {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RecentFile).path === 'string' &&
    (v as RecentFile).path.length > 0 &&
    typeof (v as RecentFile).time === 'number'
  );
}

function load(): RecentFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentFile).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function persist(list: RecentFile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 存储满等异常时静默放弃 */
  }
}

/** 最近打开文件（全局，与具体文件无关，localStorage 持久化） */
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(load);

  useEffect(() => {
    // 多实例 / 其他窗口写入时保持同步（同窗口内写入由下方回调负责）
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRecentFiles(load());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /** 打开成功后记录：插到最前、去重、截断到上限 */
  const addRecent = useCallback((path: string) => {
    setRecentFiles(prev => {
      const next = [{ path, time: Date.now() }, ...prev.filter(f => f.path !== path)].slice(
        0,
        MAX_RECENT,
      );
      persist(next);
      return next;
    });
  }, []);

  /** 移除一条（路径失效等场景） */
  const removeRecent = useCallback((path: string) => {
    setRecentFiles(prev => {
      const next = prev.filter(f => f.path !== path);
      persist(next);
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecentFiles(() => {
      persist([]);
      return [];
    });
  }, []);

  return { recentFiles, addRecent, removeRecent, clearRecent };
}
