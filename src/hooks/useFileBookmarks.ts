import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bookmark, FileMeta } from '../types';

const STORAGE_KEY = 'hex-viewer-bookmarks-v1';
/** 侧栏列表最多渲染条数（超出仅提示，不删数据） */
const MAX_RENDER_ITEMS = 500;

/** 预设调色板：三套主题（dark/light/contrast）下均有足够对比度 */
export const MARKER_COLORS = [
  '#539bf5', // 蓝
  '#57ab5a', // 绿
  '#dac000', // 黄
  '#ed8a38', // 橙
  '#e5534b', // 红
  '#b083f0', // 紫
] as const;

export const DEFAULT_MARKER_COLOR = MARKER_COLORS[0];

/** 全局存储结构：{ [文件路径]: Bookmark[] } */
type BookmarkStore = Record<string, Bookmark[]>;

function isBookmark(v: unknown): v is Bookmark {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Bookmark;
  return (
    typeof b.id === 'string' &&
    typeof b.start === 'number' &&
    typeof b.end === 'number' &&
    b.start >= 0 &&
    b.end >= b.start &&
    typeof b.name === 'string' &&
    typeof b.color === 'string'
  );
}

function loadStore(): BookmarkStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const store: BookmarkStore = {};
    for (const [path, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) {
        const valid = list.filter(isBookmark);
        if (valid.length) store[path] = valid;
      }
    }
    return store;
  } catch {
    return {};
  }
}

function saveStore(store: BookmarkStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 存储满等异常时静默放弃持久化 */
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 书签与标记管理：按文件路径持久化到 localStorage。
 * 书签 = 点（start === end），标记 = 区间；同一列表混排，对外按偏移有序。
 */
export function useFileBookmarks(fileMeta: FileMeta | null) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const path = fileMeta?.path ?? null;

  // 文件切换时加载对应路径的书签
  useEffect(() => {
    if (!path) {
      setBookmarks([]);
      return;
    }
    setBookmarks(loadStore()[path] ?? []);
  }, [path]);

  // 变化时写回（含首次加载后的幂等写，无害）
  useEffect(() => {
    if (!path) return;
    const store = loadStore();
    if (bookmarks.length) store[path] = bookmarks;
    else delete store[path];
    saveStore(store);
  }, [bookmarks, path]);

  /** 切换光标处的书签：已有则删除，没有则新建（Ctrl+B）。返回是否新建 */
  const toggleBookmarkAt = useCallback(
    (offset: number): boolean => {
      const exists = bookmarks.some(b => b.start === offset && b.end === offset);
      setBookmarks(
        exists
          ? prev => prev.filter(b => !(b.start === offset && b.end === offset))
          : [...bookmarks, { id: newId(), start: offset, end: offset, name: '', color: DEFAULT_MARKER_COLOR, createdAt: Date.now() }],
      );
      return !exists;
    },
    [bookmarks],
  );

  /** 把选择区间转成标记（Ctrl+Shift+B） */
  const addMark = useCallback((start: number, end: number) => {
    setBookmarks(prev => [
      ...prev,
      { id: newId(), start, end, name: '', color: DEFAULT_MARKER_COLOR, createdAt: Date.now() },
    ]);
  }, []);

  const removeBookmark = useCallback((id: string) => {
    setBookmarks(prev => prev.filter(b => b.id !== id));
  }, []);

  const updateBookmark = useCallback((id: string, patch: Partial<Omit<Bookmark, 'id'>>) => {
    setBookmarks(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const clearAll = useCallback(() => {
    setBookmarks([]);
  }, []);

  /** 按 start 排序的只读视图（F2 导航与列表渲染共用） */
  const sorted = useMemo(() => [...bookmarks].sort((a, b) => a.start - b.start), [bookmarks]);

  /** 光标之后的下一个书签/标记，到末尾则循环到开头 */
  const jumpNext = useCallback(
    (fromOffset: number): Bookmark | null => {
      if (!sorted.length) return null;
      const idx = sorted.findIndex(b => b.start > fromOffset);
      return sorted[idx === -1 ? 0 : idx];
    },
    [sorted],
  );

  /** 光标之前的上一个书签/标记，到开头则循环到末尾 */
  const jumpPrev = useCallback(
    (fromOffset: number): Bookmark | null => {
      if (!sorted.length) return null;
      const idx = sorted.findIndex(b => b.start >= fromOffset);
      // idx === -1：全部在光标之前；idx === 0：光标之前没有 → 都循环到最后一个
      return idx <= 0 ? sorted[sorted.length - 1] : sorted[idx - 1];
    },
    [sorted],
  );

  return {
    bookmarks,
    sorted,
    maxRenderItems: MAX_RENDER_ITEMS,
    toggleBookmarkAt,
    addMark,
    removeBookmark,
    updateBookmark,
    clearAll,
    jumpNext,
    jumpPrev,
  };
}
