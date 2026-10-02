import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileMeta } from '../types';

/** 单条字节修改（oldValue = 操作前当前显示值） */
export interface ByteChange {
  offset: number;
  oldValue: number;
  newValue: number;
}

/** 操作记录中的不可变条目 */
export interface EditOp {
  id: string;
  /** 人可读描述（如 “@0x00000010 41→42”） */
  label: string;
  time: number;
  changes: ByteChange[];
}

/**
 * 线性历史模型：
 * - ops[0..pos)     已生效（显示中可见）
 * - ops[pos..]      已撤销、可恢复
 * - ops[0..diskOps) 已写入磁盘（保存点）
 * 显示覆盖层 = 显示内容相对磁盘内容的差异，由 ops 区间推导，无需读取原始文件。
 */
interface History {
  ops: EditOp[];
  pos: number;
  diskOps: number;
}

const EMPTY_HISTORY: History = { ops: [], pos: 0, diskOps: 0 };
const EMPTY_MAP: ReadonlyMap<number, number> = new Map();
const STORAGE_KEY = 'hex-viewer-history-v1';
/** 最多为多少个文件保留持久化历史 */
const MAX_FILES = 32;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidOp(op: unknown): op is EditOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as Partial<EditOp>;
  if (
    typeof o.id !== 'string' ||
    typeof o.label !== 'string' ||
    typeof o.time !== 'number' ||
    !Array.isArray(o.changes) ||
    o.changes.length === 0
  ) {
    return false;
  }
  return o.changes.every(
    c =>
      !!c &&
      Number.isInteger(c.offset) &&
      c.offset >= 0 &&
      Number.isInteger(c.oldValue) &&
      c.oldValue >= 0 &&
      c.oldValue <= 255 &&
      Number.isInteger(c.newValue) &&
      c.newValue >= 0 &&
      c.newValue <= 255,
  );
}

/** 读取文件历史；结构异常时整体放弃（避免索引错位破坏模型） */
function loadHistory(path: string): History {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_HISTORY;
    const all = JSON.parse(raw) as Record<
      string,
      { ops?: unknown; diskOps?: unknown } | undefined
    >;
    const entry = all[path];
    if (!entry || !Array.isArray(entry.ops) || entry.ops.length === 0) return EMPTY_HISTORY;
    if (!entry.ops.every(isValidOp)) return EMPTY_HISTORY;
    const diskOps = Math.max(
      0,
      Math.min(entry.ops.length, Math.floor(Number(entry.diskOps) || 0)),
    );
    // 重新打开：未保存修改不跨会话，从磁盘状态起步（其后操作仍可恢复）
    return { ops: entry.ops as EditOp[], pos: diskOps, diskOps };
  } catch {
    return EMPTY_HISTORY;
  }
}

/** 持久化（配额不足时降级：丢弃可恢复尾部 → 放弃该文件历史），并限制保留的文件数 */
function saveHistory(path: string, history: History): void {
  const write = (ops: EditOp[], diskOps: number): boolean => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (ops.length === 0) {
        delete all[path];
      } else {
        // 淘汰最久未更新的其他文件历史
        const others = Object.keys(all).filter(k => k !== path);
        if (others.length >= MAX_FILES) {
          others
            .sort(
              (a, b) =>
                Number((all[a] as { t?: number } | undefined)?.t ?? 0) -
                Number((all[b] as { t?: number } | undefined)?.t ?? 0),
            )
            .slice(0, others.length - MAX_FILES + 1)
            .forEach(k => delete all[k]);
        }
        all[path] = { ops, diskOps, t: Date.now() };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      return true;
    } catch {
      return false;
    }
  };
  if (write(history.ops, history.diskOps)) return;
  if (history.ops.length > history.diskOps) {
    if (write(history.ops.slice(0, history.diskOps), history.diskOps)) return;
  }
  console.warn(`编辑历史持久化失败: ${path}`);
}

/**
 * 由历史推导显示覆盖层（显示值相对磁盘内容的差异）：
 * - pos > diskOps：叠加 [diskOps, pos) 各操作的新值（后写覆盖）
 * - pos < diskOps：回退 [pos, diskOps) 各操作到旧值（倒序遍历使最早一次的 oldValue 生效）
 */
function buildOverlay({ ops, pos, diskOps }: History): ReadonlyMap<number, number> {
  if (pos === diskOps) return EMPTY_MAP;
  const map = new Map<number, number>();
  if (pos > diskOps) {
    for (let i = diskOps; i < pos; i++) {
      for (const c of ops[i].changes) map.set(c.offset, c.newValue);
    }
  } else {
    for (let i = diskOps - 1; i >= pos; i--) {
      for (const c of ops[i].changes) map.set(c.offset, c.oldValue);
    }
  }
  return map;
}

/**
 * 等长编辑历史（覆盖层 + 撤销/恢复 + 操作记录）：
 * - 覆盖层不写磁盘、不动 mmap；App 层用包装后的 getBytes 应用到显示
 * - 历史按文件持久化到 localStorage，下次打开可继续撤销/恢复
 * - 注意：若文件在会话间被外部修改，旧操作记录的 oldValue 可能与磁盘不符（与编辑器崩溃恢复一致的取舍）
 */
export function useFileEdits(fileMeta: FileMeta | null) {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const path = fileMeta?.path ?? null;

  // 切换文件：载入该文件的持久化历史
  useEffect(() => {
    setHistory(path ? loadHistory(path) : EMPTY_HISTORY);
  }, [path]);

  // 历史变化即持久化
  useEffect(() => {
    if (path) saveHistory(path, history);
  }, [path, history]);

  /** 显示覆盖层（引用稳定：仅历史变化时重建，供 Row memo 比较） */
  const edits = useMemo(() => buildOverlay(history), [history]);

  /**
   * 应用一次编辑：丢弃被撤销的尾部后追加。
   * 撤销状态下继续编辑 = 永久放弃被撤销的分支（记录层面真正删除）。
   */
  const applyEdit = useCallback((changes: ByteChange[], label: string) => {
    if (!changes.length) return;
    setHistory(h => {
      let payload = changes;
      let diskOps = h.diskOps;
      if (h.pos < h.diskOps) {
        // 已撤销到保存点以下又继续编辑：把已保存操作的反向差异并入新操作，
        // 保持线性前缀模型；代价是撤销该操作会直接回到磁盘状态
        const revert = new Map<number, number>();
        for (let i = h.diskOps - 1; i >= h.pos; i--) {
          for (const c of h.ops[i].changes) revert.set(c.offset, c.oldValue);
        }
        const touched = new Set(changes.map(c => c.offset));
        payload = changes.map(c => ({
          offset: c.offset,
          oldValue: revert.get(c.offset) ?? c.oldValue,
          newValue: c.newValue,
        }));
        for (const [offset, v] of revert) {
          if (!touched.has(offset)) payload.push({ offset, oldValue: v, newValue: v });
        }
        payload = [...payload].sort((a, b) => a.offset - b.offset);
        diskOps = h.pos;
      }
      const ops = h.ops.slice(0, h.pos);
      ops.push({ id: genId(), label, time: Date.now(), changes: payload });
      return { ops, pos: ops.length, diskOps };
    });
  }, []);

  /** 撤销最近一次操作（Ctrl+Z，无需确认） */
  const undoLast = useCallback(() => {
    setHistory(h => (h.pos > 0 ? { ...h, pos: h.pos - 1 } : h));
  }, []);

  /** 恢复最近一次被撤销的操作（Ctrl+Shift+Z / Ctrl+Y） */
  const redoLast = useCallback(() => {
    setHistory(h => (h.pos < h.ops.length ? { ...h, pos: h.pos + 1 } : h));
  }, []);

  /** 撤销到第 index 个操作：该操作及其后所有已生效操作一并撤销（更早时由 App 层确认） */
  const undoTo = useCallback((index: number) => {
    setHistory(h => {
      const target = Math.max(0, Math.min(index, h.pos));
      return target === h.pos ? h : { ...h, pos: target };
    });
  }, []);

  /** 恢复到第 index 个操作：含其前被撤销的中间操作（恢复到时间点） */
  const redoTo = useCallback((index: number) => {
    setHistory(h => {
      const target = Math.max(h.pos, Math.min(index + 1, h.ops.length));
      return target === h.pos ? h : { ...h, pos: target };
    });
  }, []);

  /** 保存成功：当前显示状态即为磁盘状态（操作记录与可恢复尾部保留） */
  const afterSave = useCallback(() => {
    setHistory(h => ({ ...h, diskOps: h.pos }));
  }, []);

  /** 放弃全部未保存修改：回到磁盘状态，并删除可恢复尾部 */
  const discardUnsaved = useCallback(() => {
    setHistory(h => ({ ops: h.ops.slice(0, h.diskOps), pos: h.diskOps, diskOps: h.diskOps }));
  }, []);

  return {
    /** 偏移 → 显示字节值（相对磁盘的差异） */
    edits,
    editCount: edits.size,
    /** 操作记录（时间升序） */
    ops: history.ops,
    /** 当前生效操作数：ops[0..pos) 生效 */
    pos: history.pos,
    diskOps: history.diskOps,
    canUndo: history.pos > 0,
    canRedo: history.pos < history.ops.length,
    applyEdit,
    undoLast,
    redoLast,
    undoTo,
    redoTo,
    afterSave,
    discardUnsaved,
  };
}
