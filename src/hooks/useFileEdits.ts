import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ByteChange, EditOp, EditSnapshot, FileMeta, StructPrim } from '../types';

// 供侧栏 / 版本 hook 等复用（类型再导出）
export type { ByteChange, EditOp };

/**
 * 混合操作历史模型（v1.1.4）：
 * - ops[0..pos)     已生效（显示中可见）
 * - ops[pos..]      已撤销、可恢复
 * - ops[0..diskOps) 与磁盘状态对齐的窗口起点（保存点）
 * - piece 表（Rust）= 磁盘内容 + 结构性命令（窗口 [diskOps, pos) 的 insert/delete）
 * - 显示 = piece 表 + 覆盖层（窗口内 replace 操作推导，偏移经结构性原语坐标映射）
 *
 * 在保存点以下追加编辑时，把已保存尾部的反向操作并入新操作（复合化），
 * 保持线性前缀模型；代价是撤销该操作会直接回到磁盘状态（与 v1.1.3 语义一致）。
 *
 * 结构性命令（insert_bytes / delete_range）在动作方法内立即发出，
 * 依靠 Tauri 主线程同步命令按 IPC 到达顺序执行保证与后续 read_chunk 的时序。
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

/** 光标 / 选择 / 书签跟随用的坐标动作（由结构命令导出） */
export interface StructAction {
  kind: 'insert' | 'delete';
  offset: number;
  length: number;
}

/** 最近一次结构性变更（FileTab 据此重映射光标 / 选择 / 书签并失效分片缓存） */
export interface StructChange {
  epoch: number;
  actions: StructAction[];
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidBytes(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(b => Number.isInteger(b) && b >= 0 && b <= 255)
  );
}

function isValidOp(op: unknown): op is EditOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as Partial<EditOp> & { changes?: unknown; offset?: unknown; bytes?: unknown; ops?: unknown };
  if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.time !== 'number') {
    return false;
  }
  switch (o.kind) {
    case 'replace':
      return (
        Array.isArray(o.changes) &&
        o.changes.length > 0 &&
        o.changes.every(
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
        )
      );
    case 'insert':
    case 'delete': {
      const off = o.offset as unknown;
      return Number.isInteger(off) && (off as number) >= 0 && isValidBytes(o.bytes);
    }
    case 'composite':
      return Array.isArray(o.ops) && o.ops.length > 0 && o.ops.every(isValidOp);
    default:
      return false;
  }
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

// ============ 结构性原语工具 ============

/** 单个操作 → 原语（replace 无原语） */
function opPrims(op: EditOp): StructPrim[] {
  if (op.kind === 'insert' || op.kind === 'delete') {
    return [{ kind: op.kind, offset: op.offset, bytes: op.bytes }];
  }
  if (op.kind === 'composite') {
    return op.ops.flatMap(opPrims);
  }
  return [];
}

/** 顺序展开 ops[from..to) 的全部原语 */
function flattenPrims(ops: EditOp[], from: number, to: number): StructPrim[] {
  const out: StructPrim[] = [];
  for (let i = from; i < to; i++) out.push(...opPrims(ops[i]));
  return out;
}

/** 原语反转（insert ↔ delete，delete 携带原字节以便恢复） */
function invertPrim(p: StructPrim): StructPrim {
  return p.kind === 'insert'
    ? { kind: 'delete', offset: p.offset, bytes: p.bytes }
    : { kind: 'insert', offset: p.offset, bytes: p.bytes };
}

/** 逆序展开并逐个反转（撤销窗口用）：序列反转 = 倒序 + 逐个取逆 */
function flattenReversedPrims(ops: EditOp[], from: number, to: number): StructPrim[] {
  const out: StructPrim[] = [];
  for (let i = to - 1; i >= from; i--) {
    const prims = opPrims(ops[i]);
    for (let j = prims.length - 1; j >= 0; j--) out.push(invertPrim(prims[j]));
  }
  return out;
}

/** 操作取反（生成保存点以下追加时的复合子操作） */
function invertOp(op: EditOp): EditOp {
  switch (op.kind) {
    case 'replace':
      return {
        ...op,
        id: genId(),
        changes: op.changes.map(c => ({
          offset: c.offset,
          oldValue: c.newValue,
          newValue: c.oldValue,
        })),
      };
    case 'insert':
      return { id: genId(), label: op.label, time: Date.now(), kind: 'delete', offset: op.offset, bytes: op.bytes };
    case 'delete':
      return { id: genId(), label: op.label, time: Date.now(), kind: 'insert', offset: op.offset, bytes: op.bytes };
    case 'composite': {
      const inner = [...op.ops].reverse().map(invertOp);
      return { id: genId(), label: op.label, time: Date.now(), kind: 'composite', ops: inner };
    }
  }
}

/** 坐标正向映射：o 经过 prims（按顺序）后的位置；落入被删除区间返回 null */
function shiftOffsetFwd(prims: StructPrim[], o: number): number | null {
  for (const p of prims) {
    const len = p.bytes.length;
    if (p.kind === 'insert') {
      if (o >= p.offset) o += len;
    } else {
      if (o >= p.offset + len) o -= len;
      else if (o >= p.offset) return null;
    }
  }
  return o;
}

/** 坐标反向映射：o（位于 prims 作用后的空间）回到原空间 */
function shiftOffsetBack(prims: StructPrim[], o: number): number | null {
  for (let i = prims.length - 1; i >= 0; i--) {
    const p = prims[i];
    const len = p.bytes.length;
    if (p.kind === 'insert') {
      if (o >= p.offset + len) o -= len;
      else if (o >= p.offset) return null;
    } else {
      if (o >= p.offset) o += len;
    }
  }
  return o;
}

/**
 * 由历史推导显示覆盖层（显示值相对 piece 表内容的差异）。
 * replace 偏移按其后（正向）/其前（反向）的结构性原语做坐标映射；
 * 落入删除区间的替换点直接跳过（目标字节已不存在）。
 */
function buildOverlay({ ops, pos, diskOps }: History): ReadonlyMap<number, number> {
  if (pos === diskOps) return EMPTY_MAP;
  const map = new Map<number, number>();
  if (pos > diskOps) {
    // 正向窗口 [diskOps, pos)：倒序收集（维护"其后原语"），再正序应用使晚的操作覆盖
    const entries: Array<[number, number]> = [];
    const walk = (list: EditOp[], from: number, to: number, after: StructPrim[]) => {
      for (let i = to - 1; i >= from; i--) {
        const op = list[i];
        if (op.kind === 'replace') {
          for (const c of op.changes) {
            const o = shiftOffsetFwd(after, c.offset);
            if (o !== null) entries.push([o, c.newValue]);
          }
        } else if (op.kind === 'composite') {
          walk(op.ops, 0, op.ops.length, after);
          after = [...flattenPrims(op.ops, 0, op.ops.length), ...after];
        } else {
          after = [opPrims(op)[0], ...after];
        }
      }
    };
    walk(ops, diskOps, pos, []);
    for (let i = entries.length - 1; i >= 0; i--) map.set(entries[i][0], entries[i][1]);
  } else {
    // 反向窗口 [pos, diskOps)：正序收集（维护"其前原语"），再倒序应用使最早操作的 oldValue 生效
    const entries: Array<[number, number]> = [];
    const walk = (list: EditOp[], from: number, to: number, before: StructPrim[]) => {
      for (let i = from; i < to; i++) {
        const op = list[i];
        if (op.kind === 'replace') {
          for (const c of op.changes) {
            const o = shiftOffsetBack(before, c.offset);
            if (o !== null) entries.push([o, c.oldValue]);
          }
        } else if (op.kind === 'composite') {
          walk(op.ops, 0, op.ops.length, before);
          before = [...before, ...flattenPrims(op.ops, 0, op.ops.length)];
        } else {
          before = [...before, opPrims(op)[0]];
        }
      }
    };
    walk(ops, pos, diskOps, []);
    for (let i = entries.length - 1; i >= 0; i--) map.set(entries[i][0], entries[i][1]);
  }
  return map;
}

/** 窗口（[diskOps, pos) 或 [pos, diskOps)）内的结构性原语与方向 */
function windowPrims({ ops, pos, diskOps }: History): { prims: StructPrim[]; reversed: boolean } {
  if (pos === diskOps) return { prims: [], reversed: false };
  if (pos > diskOps) return { prims: flattenPrims(ops, diskOps, pos), reversed: false };
  return { prims: flattenReversedPrims(ops, pos, diskOps), reversed: true };
}

/**
 * 混合编辑历史（覆盖层 + 插入/删除 + 撤销/恢复 + 操作记录）：
 * - 等长替换仍由覆盖层推导；插入/删除即时下发 Rust piece 表
 * - 历史按文件持久化到 localStorage，下次打开可继续撤销/恢复（未保存修改不跨会话）
 */
export function useFileEdits(tabId: string | null, fileMeta: FileMeta | null) {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [structChange, setStructChange] = useState<StructChange | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const epochRef = useRef(0);
  const historyRef = useRef<History>(EMPTY_HISTORY);
  const path = fileMeta?.path ?? null;

  const commit = useCallback((next: History) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  // 切换文件：载入该文件的持久化历史
  useEffect(() => {
    const loaded = path ? loadHistory(path) : EMPTY_HISTORY;
    historyRef.current = loaded;
    setHistory(loaded);
    setStructChange(null);
    setSyncError(null);
  }, [path]);

  // 历史变化即持久化
  useEffect(() => {
    if (path) saveHistory(path, history);
  }, [path, history]);

  /** 显示覆盖层（引用稳定：仅历史变化时重建，供 Row memo 比较） */
  const edits = useMemo(() => buildOverlay(history), [history]);

  /** 发出结构性命令并广播坐标动作（供 FileTab 重映射光标/选择/书签 + 失效缓存） */
  const runPrims = useCallback(
    (prims: StructPrim[]) => {
      if (!tabId || prims.length === 0) return;
      for (const p of prims) {
        const cmd =
          p.kind === 'insert'
            ? invoke('insert_bytes', { tabId, offset: p.offset, bytes: p.bytes })
            : invoke('delete_range', { tabId, offset: p.offset, len: p.bytes.length });
        cmd.catch(err => {
          console.error('结构编辑命令失败:', err);
          setSyncError(String(err));
        });
      }
      epochRef.current += 1;
      setStructChange({
        epoch: epochRef.current,
        actions: prims.map(p => ({
          kind: p.kind,
          offset: p.offset,
          length: p.bytes.length,
        })),
      });
    },
    [tabId],
  );

  /** 在当前历史末尾追加一个操作（保存点以下时复合化） */
  const appendOp = useCallback(
    (op: EditOp): History => {
      const h = historyRef.current;
      if (h.pos >= h.diskOps) {
        const ops = [...h.ops.slice(0, h.pos), op];
        return { ops, pos: ops.length, diskOps: h.diskOps };
      }
      // 保存点以下追加：并入已保存尾部的反向操作，diskOps 前移到截断点
      const revs: EditOp[] = [];
      for (let i = h.diskOps - 1; i >= h.pos; i--) revs.push(invertOp(h.ops[i]));
      const composite: EditOp = {
        id: genId(),
        label: op.label,
        time: Date.now(),
        kind: 'composite',
        ops: [...revs, op],
      };
      const ops = [...h.ops.slice(0, h.pos), composite];
      return { ops, pos: ops.length, diskOps: h.pos };
    },
    [],
  );

  /** 应用一次等长编辑（v1 行为保持：oldValue = 操作前显示值） */
  const applyEdit = useCallback(
    (changes: ByteChange[], label: string) => {
      if (!changes.length) return;
      const op: EditOp = {
        id: genId(),
        label,
        time: Date.now(),
        kind: 'replace',
        changes,
      };
      commit(appendOp(op));
    },
    [appendOp, commit],
  );

  /** 在虚拟偏移处插入字节（Rust piece 表即时更新） */
  const applyInsert = useCallback(
    (offset: number, bytes: number[], label: string) => {
      if (bytes.length === 0) return;
      const op: EditOp = { id: genId(), label, time: Date.now(), kind: 'insert', offset, bytes };
      commit(appendOp(op));
      runPrims([{ kind: 'insert', offset, bytes }]);
    },
    [appendOp, commit, runPrims],
  );

  /** 删除虚拟区间（调用方先读出被删内容用于撤销/重做恢复） */
  const applyDelete = useCallback(
    (offset: number, deletedBytes: number[], label: string) => {
      if (deletedBytes.length === 0) return;
      const op: EditOp = {
        id: genId(),
        label,
        time: Date.now(),
        kind: 'delete',
        offset,
        bytes: deletedBytes,
      };
      commit(appendOp(op));
      runPrims([{ kind: 'delete', offset, bytes: deletedBytes }]);
    },
    [appendOp, commit, runPrims],
  );

  /** 追加复合操作（版本恢复 / 外部生成的多步变更），内部原语按序即时下发 */
  const applyComposite = useCallback(
    (inner: EditOp[], label: string) => {
      if (inner.length === 0) return;
      const composite: EditOp = {
        id: genId(),
        label,
        time: Date.now(),
        kind: 'composite',
        ops: inner,
      };
      commit(appendOp(composite));
      // 保存点以下时复合操作里已含反向子操作（其命令在撤销时已下发），这里只下发新子操作
      runPrims(flattenPrims(inner, 0, inner.length));
    },
    [appendOp, commit, runPrims],
  );

  /** 撤销最近一次操作（Ctrl+Z，无需确认） */
  const undoLast = useCallback(() => {
    const h = historyRef.current;
    if (h.pos <= 0) return;
    runPrims(flattenReversedPrims(h.ops, h.pos - 1, h.pos));
    commit({ ...h, pos: h.pos - 1 });
  }, [commit, runPrims]);

  /** 恢复最近一次被撤销的操作（Ctrl+Shift+Z / Ctrl+Y） */
  const redoLast = useCallback(() => {
    const h = historyRef.current;
    if (h.pos >= h.ops.length) return;
    runPrims(flattenPrims(h.ops, h.pos, h.pos + 1));
    commit({ ...h, pos: h.pos + 1 });
  }, [commit, runPrims]);

  /** 撤销到第 index 个操作：该操作及其后所有已生效操作一并撤销（更早时由 App 层确认） */
  const undoTo = useCallback(
    (index: number) => {
      const h = historyRef.current;
      const target = Math.max(0, Math.min(index, h.pos));
      if (target === h.pos) return;
      runPrims(flattenReversedPrims(h.ops, target, h.pos));
      commit({ ...h, pos: target });
    },
    [commit, runPrims],
  );

  /** 恢复到第 index 个操作：含其前被撤销的中间操作（恢复到时间点） */
  const redoTo = useCallback(
    (index: number) => {
      const h = historyRef.current;
      const target = Math.max(h.pos, Math.min(index + 1, h.ops.length));
      if (target === h.pos) return;
      runPrims(flattenPrims(h.ops, h.pos, target));
      commit({ ...h, pos: target });
    },
    [commit, runPrims],
  );

  /** 保存成功：当前显示状态即为磁盘状态（操作记录与可恢复尾部保留） */
  const afterSave = useCallback(() => {
    const h = historyRef.current;
    commit({ ...h, diskOps: h.pos });
  }, [commit]);

  /** 放弃全部未保存修改：回到磁盘状态，并删除可恢复尾部 */
  const discardUnsaved = useCallback(() => {
    const h = historyRef.current;
    if (h.pos > h.diskOps) {
      runPrims(flattenReversedPrims(h.ops, h.diskOps, h.pos));
    }
    commit({ ops: h.ops.slice(0, h.diskOps), pos: h.diskOps, diskOps: h.diskOps });
  }, [commit, runPrims]);

  /** 崩溃恢复：用快照整体替换当前历史，并重放窗口内的结构性命令 */
  const restoreSnapshot = useCallback(
    (snap: EditSnapshot) => {
      if (!Array.isArray(snap.ops) || !snap.ops.every(isValidOp)) return false;
      const ops = snap.ops as EditOp[];
      const diskOps = Math.max(0, Math.min(ops.length, Math.floor(snap.diskOps) || 0));
      const pos = Math.max(0, Math.min(ops.length, Math.floor(snap.pos) || 0));
      const next: History = { ops, pos, diskOps };
      commit(next);
      if (pos > diskOps) runPrims(flattenPrims(ops, diskOps, pos));
      else if (pos < diskOps) runPrims(flattenReversedPrims(ops, pos, diskOps));
      return true;
    },
    [commit, runPrims],
  );

  /** 当前快照（autosave 载荷用） */
  const getSnapshot = useCallback((): EditSnapshot => {
    const h = historyRef.current;
    return { ops: h.ops, pos: h.pos, diskOps: h.diskOps };
  }, []);

  const { prims: winPrims, reversed: winReversed } = useMemo(
    () => windowPrims(history),
    [history],
  );
  /** 虚拟大小相对磁盘的增量（插入 + 删除 -，窗口反向时取负） */
  const virtualDelta = useMemo(
    () =>
      winPrims.reduce(
        (acc, p) => acc + (p.kind === 'insert' ? 1 : -1) * p.bytes.length,
        0,
      ) * (winReversed ? -1 : 1),
    [winPrims, winReversed],
  );
  /** 窗口内结构性变更的字节总量（editCount 的结构部分） */
  const structBytes = useMemo(
    () => winPrims.reduce((acc, p) => acc + p.bytes.length, 0),
    [winPrims],
  );

  return {
    /** 偏移 → 显示字节值（相对 piece 表内容的差异，偏移为虚拟偏移） */
    edits,
    editCount: edits.size + structBytes,
    /** 操作记录（时间升序） */
    ops: history.ops,
    /** 当前生效操作数：ops[0..pos) 生效 */
    pos: history.pos,
    diskOps: history.diskOps,
    canUndo: history.pos > 0,
    canRedo: history.pos < history.ops.length,
    /** 虚拟大小 - 磁盘大小 */
    virtualDelta,
    /** 最近一次结构性变更（epoch 单调递增；actions 为坐标动作序列） */
    structChange,
    /** Rust 命令失败信息（正常应为 null） */
    syncError,
    clearSyncError: useCallback(() => setSyncError(null), []),
    applyEdit,
    applyInsert,
    applyDelete,
    applyComposite,
    undoLast,
    redoLast,
    undoTo,
    redoTo,
    afterSave,
    discardUnsaved,
    restoreSnapshot,
    getSnapshot,
  };
}
