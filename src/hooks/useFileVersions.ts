import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileMeta } from '../types';
import type { ByteChange, EditOp } from './useFileEdits';

/** 版本元数据（镜像 Rust VersionMeta，camelCase） */
export interface VersionMeta {
  id: string;
  /** 记录时刻（unix 毫秒） */
  time: number;
  label: string;
  /** 相对基线的改动字节数 */
  byteCount: number;
  /** 版本数据文件大小（压缩后，字节） */
  sizeBytes: number;
  hash: string;
}

/** 版本内容与当前显示内容的差异（Rust 端计算） */
interface VersionDiff {
  changes: { offset: number; oldValue: number; newValue: number }[];
  skipped: number;
}

/** 清理选项：三选一 */
export interface CleanupOptions {
  keepCount?: number;
  keepDays?: number;
  all?: boolean;
}

/** 全局版本存储软上限（超出仅提示清理） */
const GLOBAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** useFileEdits 的 API 面（以 ref 持有，回调恒定且始终读到最新编辑状态） */
interface EditsApi {
  edits: ReadonlyMap<number, number>;
  ops: EditOp[];
  pos: number;
  applyEdit: (changes: ByteChange[], label: string) => void;
}

/**
 * 历史版本记录（v1.0.2.003）：
 * - 记录：把当前 ops 快照 + 显示覆盖层存为相对 base.bin 的独立版本
 * - 预览：版本差异叠成临时覆盖层替换显示（只读），退出即还原
 * - 恢复：版本与真实状态的差异作为一个新编辑操作追加（可 Ctrl+Z 撤销），磁盘不变
 */
export function useFileVersions(fileMeta: FileMeta | null, editsApi: EditsApi) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewOverlay, setPreviewOverlay] = useState<ReadonlyMap<number, number> | null>(null);
  const [globalSize, setGlobalSize] = useState(0);
  const path = fileMeta?.path ?? null;
  const hasFile = !!fileMeta && fileMeta.size > 0;

  // 始终指向最新的编辑 API（保存后立即记录版本等场景不受渲染时机影响）
  const editsRef = useRef(editsApi);
  editsRef.current = editsApi;

  const exitPreview = useCallback(() => {
    setPreviewId(null);
    setPreviewOverlay(null);
  }, []);

  const refreshGlobalSize = useCallback(() => {
    invoke<number>('versions_global_size')
      .then(setGlobalSize)
      .catch(() => {/* 目录不存在等情况忽略 */});
  }, []);

  const refresh = useCallback(() => {
    if (!path) return;
    invoke<VersionMeta[]>('list_versions', { filePath: path })
      .then(setVersions)
      .catch(() => setVersions([]));
    refreshGlobalSize();
  }, [path, refreshGlobalSize]);

  // 切换文件：退出预览并载入该文件的版本列表
  useEffect(() => {
    exitPreview();
    if (!path || !hasFile) {
      setVersions([]);
      return;
    }
    invoke<VersionMeta[]>('list_versions', { filePath: path })
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [path, hasFile, exitPreview]);

  useEffect(() => {
    if (path && hasFile) refreshGlobalSize();
  }, [path, hasFile, refreshGlobalSize]);

  /** 记录当前状态为一个版本；返回是否真正写入（与最新版本相同则跳过） */
  const recordVersion = useCallback(
    async (label: string): Promise<boolean> => {
      if (!path) throw new Error('尚未打开文件');
      const { edits, ops, pos } = editsRef.current;
      const saved = await invoke<VersionMeta | null>('save_version', {
        filePath: path,
        payload: {
          label,
          ops,
          pos,
          edits: Array.from(edits, ([offset, value]) => [offset, value]),
        },
      });
      if (saved) {
        setVersions(v => [saved, ...v]);
        refreshGlobalSize();
        return true;
      }
      return false;
    },
    [path, refreshGlobalSize],
  );

  /** 计算版本与真实状态（磁盘+未保存编辑，不含预览覆盖层）的差异 */
  const loadDiff = useCallback(
    async (versionId: string): Promise<VersionDiff> => {
      if (!path) throw new Error('尚未打开文件');
      return invoke<VersionDiff>('load_version_diff', {
        filePath: path,
        versionId,
        edits: Array.from(editsRef.current.edits, ([offset, value]) => [offset, value]),
      });
    },
    [path],
  );

  /** 进入版本预览：真实编辑 + 版本差异 → 临时覆盖层（替换显示，只读） */
  const enterPreview = useCallback(
    async (versionId: string): Promise<void> => {
      const diff = await loadDiff(versionId);
      const overlay = new Map(editsRef.current.edits);
      for (const c of diff.changes) overlay.set(c.offset, c.newValue);
      setPreviewOverlay(overlay);
      setPreviewId(versionId);
    },
    [loadDiff],
  );

  /** 切换预览：再点同一个版本则退出 */
  const togglePreview = useCallback(
    async (versionId: string): Promise<void> => {
      if (previewId === versionId) exitPreview();
      else await enterPreview(versionId);
    },
    [previewId, enterPreview, exitPreview],
  );

  /** 恢复版本：差异作为一个新编辑操作追加（可撤销）；恢复后展示真实状态，退出预览 */
  const restoreVersion = useCallback(
    async (versionId: string): Promise<{ changes: number; skipped: number }> => {
      const diff = await loadDiff(versionId);
      const label = versions.find(v => v.id === versionId)?.label ?? '未知版本';
      if (diff.changes.length > 0) {
        editsRef.current.applyEdit(
          diff.changes.map(c => ({ offset: c.offset, oldValue: c.oldValue, newValue: c.newValue })),
          `恢复至版本 ${label}`,
        );
      }
      // 无论此前预览的是哪个版本：恢复后显示真实编辑状态
      exitPreview();
      return { changes: diff.changes.length, skipped: diff.skipped };
    },
    [versions, loadDiff, exitPreview],
  );

  /** 删除版本（删除预览中的版本时一并退出预览） */
  const deleteVersionById = useCallback(
    async (versionId: string): Promise<void> => {
      if (!path) return;
      await invoke('delete_version', { filePath: path, versionId });
      setVersions(v => v.filter(x => x.id !== versionId));
      if (previewId === versionId) exitPreview();
      refreshGlobalSize();
    },
    [path, previewId, exitPreview, refreshGlobalSize],
  );

  /** 重命名版本标签 */
  const renameVersionById = useCallback(
    async (versionId: string, label: string): Promise<void> => {
      if (!path) return;
      await invoke('rename_version', { filePath: path, versionId, label });
      setVersions(v => v.map(x => (x.id === versionId ? { ...x, label } : x)));
    },
    [path],
  );

  /** 清理旧版本，返回删除的数量；清理可能波及预览中的版本，先退出预览 */
  const cleanupVersions = useCallback(
    async (opts: CleanupOptions): Promise<number> => {
      if (!path) return 0;
      exitPreview();
      const deleted = await invoke<number>('cleanup_versions', {
        filePath: path,
        keepCount: opts.keepCount ?? null,
        keepDays: opts.keepDays ?? null,
        all: opts.all ?? false,
      });
      refresh();
      return deleted;
    },
    [path, refresh, exitPreview],
  );

  const previewVersion = useMemo(
    () => (previewId ? versions.find(v => v.id === previewId) ?? null : null),
    [previewId, versions],
  );

  return {
    /** 版本列表（最新在前） */
    versions,
    previewId,
    /** 预览中版本的元数据 */
    previewVersion,
    /** 预览临时覆盖层（非预览时为 null）；App 以 displayEdits = previewOverlay ?? edits 应用到显示 */
    previewOverlay,
    /** 是否处于预览状态 */
    previewing: previewId !== null,
    /** 全局版本存储总大小（字节） */
    globalSize,
    /** 全局存储超过 2GB 软上限 */
    overLimit: globalSize > GLOBAL_LIMIT_BYTES,
    recordVersion,
    togglePreview,
    enterPreview,
    exitPreview,
    restoreVersion,
    deleteVersionById,
    renameVersionById,
    cleanupVersions,
    refresh,
  };
}
