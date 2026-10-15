import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { HexViewer, type HexViewerHandle } from './components/HexViewer';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { EditDialog } from './components/EditDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { useDisplayConfig } from './hooks/useDisplayConfig';
import { useFileWindow } from './hooks/useFileWindow';
import { useFileEdits } from './hooks/useFileEdits';
import { useFileSearch, type SearchMode } from './hooks/useFileSearch';
import { useFileStats } from './hooks/useFileStats';
import { usePerfMonitor } from './hooks/usePerfMonitor';
import { useFileBookmarks } from './hooks/useFileBookmarks';
import { useFileVersions, type CleanupOptions } from './hooks/useFileVersions';
import { useAiConfig } from './hooks/useAiConfig';
import { useAiChat } from './hooks/useAiChat';
import { streamChat, type ApiChatMessage } from './utils/aiClient';
import { buildAiContext } from './utils/aiContext';
import { SidebarVersions } from './components/SidebarVersions';
import { SidebarAi } from './components/SidebarAi';
import type { Bookmark, FileMeta, Selection, SidebarTab, TextEncoding } from './types';
import {
  fmtVersionTime,
  hexByte,
  hexOffset,
  makeVersionLabel,
  offsetDigits,
  parseOffsetInput,
} from './utils/format';
import { decodeBytesToText, encodingLabel } from './utils/decode';
import './App.css';

const MAX_COPY_BYTES = 4 * 1024 * 1024;
/** AI 流式请求无响应超时（毫秒），每个增量重置 */
const AI_TIMEOUT_MS = 60_000;
/** 单次请求携带的历史消息上限（含当前提问，控制提示词长度） */
const AI_HISTORY_LIMIT = 20;
/** 无选中时注入光标附近的字节数 */
const AI_CURSOR_CONTEXT = 64;

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function App() {
  const {
    config,
    setBytesPerRow,
    zoomFont,
    setTheme,
    toggleAscii,
    setEncoding,
    setEditMode,
    setConfirmSave,
    setVersionMode,
  } = useDisplayConfig();
  const {
    fileMeta,
    cacheVersion,
    cacheBytes,
    loading,
    openFile,
    closeFile,
    resetChunks,
    ensureRange,
    getBytes,
    readRange,
  } = useFileWindow();
  const search = useFileSearch(fileMeta);
  const stats = useFileStats(fileMeta);
  const perf = usePerfMonitor(true);
  const bm = useFileBookmarks(fileMeta);
  const edit = useFileEdits(fileMeta);
  const ver = useFileVersions(fileMeta, edit);
  const ai = useAiConfig();
  const aiChat = useAiChat(fileMeta);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiClearConfirmOpen, setAiClearConfirmOpen] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);

  const hexViewerRef = useRef<HexViewerHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [hoverOffset, setHoverOffset] = useState<number | null>(null);
  const [cursorOffset, setCursorOffset] = useState<number | null>(null);
  const [flashOffset, setFlashOffset] = useState<number | null>(null);
  const [activeHitOffset, setActiveHitOffset] = useState<number | null>(null);
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>('info');
  const [visibleRange, setVisibleRange] = useState<{ first: number; last: number }>({
    first: 0,
    last: 0,
  });

  // 工具栏输入状态
  const [searchMode, setSearchMode] = useState<SearchMode>('text');
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [gotoText, setGotoText] = useState('');

  // 编辑状态：直接模式行内编辑目标 / 对话框编辑区间 / 各确认弹窗 / 保存中
  const [directEditOffset, setDirectEditOffset] = useState<number | null>(null);
  const [editDialogRange, setEditDialogRange] = useState<{ start: number; end: number } | null>(
    null,
  );
  /** 未保存时挂起的动作：确认（保存/放弃）后执行 */
  const [unsavedAction, setUnsavedAction] = useState<{
    kind: 'open' | 'close';
    path: string | null;
  } | null>(null);
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  /** 待确认的"撤销到指定操作"目标索引（操作记录中撤销早期操作需二次确认） */
  const [undoConfirmIndex, setUndoConfirmIndex] = useState<number | null>(null);
  /** 待确认的"恢复历史版本"目标版本 */
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const totalRows = fileMeta ? Math.ceil(fileMeta.size / config.bytesPerRow) : 0;
  const visibleRows = Math.max(0, visibleRange.last - visibleRange.first + 1);

  /** 清空与具体文件绑定的一切交互状态（打开/关闭文件共用） */
  const resetInteractionState = useCallback(() => {
    setSelection(null);
    setHoverOffset(null);
    setCursorOffset(null);
    setActiveHitOffset(null);
    setActiveBookmarkId(null);
    setFlashOffset(null);
    setDirectEditOffset(null);
    setEditDialogRange(null);
  }, []);

  /** 实际执行打开（无确认） */
  const performOpen = useCallback(
    async (path: string) => {
      resetInteractionState();
      try {
        const meta = await openFile(path);
        // 光标初始设在偏移 0；空文件不显示光标
        setCursorOffset(meta.size > 0 ? 0 : null);
      } catch (err) {
        showToast(`打开文件失败: ${err}`);
        console.error(err);
      }
    },
    [openFile, resetInteractionState, showToast],
  );

  /** 实际执行关闭（无确认） */
  const performClose = useCallback(() => {
    closeFile();
    resetInteractionState();
  }, [closeFile, resetInteractionState]);

  const handleOpenFile = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      });
      if (!selected) return;
      const path = selected as string;
      // 预览不改动真实状态：先退出，未保存判断与保存路径不受预览影响
      ver.exitPreview();
      if (edit.editCount > 0) {
        setUnsavedAction({ kind: 'open', path });
        return;
      }
      await performOpen(path);
    } catch (err) {
      showToast(`打开文件失败: ${err}`);
      console.error(err);
    }
  }, [edit.editCount, ver, performOpen, showToast]);

  const handleCloseFile = useCallback(() => {
    if (!fileMeta) return;
    ver.exitPreview();
    if (edit.editCount > 0) {
      setUnsavedAction({ kind: 'close', path: null });
      return;
    }
    performClose();
  }, [fileMeta, edit.editCount, ver, performClose]);

  /** 未保存确认后执行挂起的打开/关闭动作 */
  const proceedUnsaved = useCallback(
    (action: { kind: 'open' | 'close'; path: string | null }) => {
      if (action.kind === 'open' && action.path) void performOpen(action.path);
      else if (action.kind === 'close') performClose();
    },
    [performOpen, performClose],
  );

  /** 跳转到指定字节偏移（居中 + 闪烁高亮 + 光标同步） */
  const jumpToOffset = useCallback(
    (offset: number) => {
      const size = fileMeta?.size ?? 0;
      if (size === 0) return;
      const target = Math.max(0, Math.min(offset, size - 1));
      setFlashOffset(target);
      setCursorOffset(target);
      hexViewerRef.current?.scrollToOffset(target);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashOffset(null), 1200);
    },
    [fileMeta],
  );

  const handleGoto = useCallback(() => {
    if (!fileMeta) return;
    const parsed = parseOffsetInput(gotoText);
    if (parsed === null) {
      showToast('无效的偏移（支持 0x 前缀 Hex 或十进制）');
      return;
    }
    if (parsed >= fileMeta.size) {
      showToast('偏移超出文件末尾');
      return;
    }
    jumpToOffset(parsed);
  }, [fileMeta, gotoText, jumpToOffset, showToast]);

  /** 把当前选择区间转成标记；成功后切到书签选项卡 */
  const addMarkFromSelection = useCallback(() => {
    if (!selection) {
      showToast('请先选择一个区间');
      return;
    }
    bm.addMark(selection.start, selection.end);
    setActiveSidebarTab('bookmarks');
    showToast(`已标记 ${selection.end - selection.start + 1} 字节`);
  }, [selection, bm, showToast]);

  /** 切换光标处书签；新建时切到书签选项卡（删除不切换） */
  const toggleBookmarkAtCursor = useCallback(
    (offset: number) => {
      if (bm.toggleBookmarkAt(offset)) setActiveSidebarTab('bookmarks');
    },
    [bm],
  );

  /** 跳转到书签/标记：点书签只跳转；范围标记同时选中整个区间 */
  const jumpToBookmark = useCallback(
    (target: Bookmark) => {
      const size = fileMeta?.size ?? 0;
      if (target.start >= size) {
        showToast('偏移超出文件末尾（文件可能已被修改）');
        return;
      }
      setActiveBookmarkId(target.id);
      if (target.start !== target.end) {
        setSelection({ start: target.start, end: Math.min(target.end, size - 1) });
      }
      jumpToOffset(target.start);
    },
    [fileMeta, jumpToOffset, showToast],
  );

  /** F2 / Shift+F2 在书签列表中循环导航 */
  const jumpBookmarkRelative = useCallback(
    (dir: 1 | -1) => {
      const from = cursorOffset ?? 0;
      const target = dir === 1 ? bm.jumpNext(from) : bm.jumpPrev(from);
      if (!target) {
        showToast('暂无书签');
        return;
      }
      jumpToBookmark(target);
    },
    [cursorOffset, bm, jumpToBookmark, showToast],
  );

  const handleSearch = useCallback(() => {
    // 空内容不发搜索，也不切换选项卡
    if (!searchText.trim()) return;
    setActiveSidebarTab('search');
    search.runSearch(searchMode, searchText, caseSensitive);
  }, [search, searchMode, searchText, caseSensitive]);

  /** 显示用覆盖层：预览历史版本时为临时覆盖层（版本内容），否则为真实编辑覆盖层 */
  const displayEdits = useMemo(
    () => ver.previewOverlay ?? edit.edits,
    [ver.previewOverlay, edit.edits],
  );

  /** 复制选中字节（Hex / 按指定编码解码的文本） */
  const copySelection = useCallback(
    async (mode: 'hex' | 'text', encoding: TextEncoding = config.encoding) => {
      if (!selection) return;
      const len = selection.end - selection.start + 1;
      if (len > MAX_COPY_BYTES) {
        showToast(`选择过大（${len} 字节），上限 4MB`);
        return;
      }
      try {
        const data = await readRange(selection.start, len);
        // 应用显示覆盖层：复制内容与视图所见一致（含版本预览）
        for (let i = 0; i < data.length; i++) {
          const v = displayEdits.get(selection.start + i);
          if (v !== undefined) data[i] = v;
        }
        let text: string;
        if (mode === 'hex') {
          const parts = new Array<string>(data.length);
          for (let i = 0; i < data.length; i++) parts[i] = hexByte(data[i]);
          text = parts.join(' ');
        } else {
          text = decodeBytesToText(data, encoding);
        }
        await writeClipboard(text);
        showToast(`已复制 ${len} 字节（${mode === 'hex' ? 'Hex' : `${encodingLabel(encoding)} 文本`}）`);
      } catch (err) {
        console.error(err);
        showToast('复制失败');
      }
    },
    [selection, readRange, showToast, config.encoding, displayEdits],
  );

  // ---------- 编辑：覆盖层应用 / 保存 / 编辑入口 ----------

  /** 应用显示覆盖层的字节读取：无覆盖零拷贝；仅含覆盖的行拷贝替换（行宽 ≤32，常数开销） */
  const displayGetBytes = useCallback(
    (offset: number, len: number): Uint8Array | null => {
      const raw = getBytes(offset, len);
      if (!raw) return null;
      if (displayEdits.size === 0) return raw;
      let has = false;
      for (let i = 0; i < raw.length; i++) {
        if (displayEdits.has(offset + i)) {
          has = true;
          break;
        }
      }
      if (!has) return raw;
      const out = new Uint8Array(raw.length);
      out.set(raw);
      for (let i = 0; i < out.length; i++) {
        const v = displayEdits.get(offset + i);
        if (v !== undefined) out[i] = v;
      }
      return out;
    },
    [getBytes, displayEdits],
  );

  /** 覆盖层 → 后端保存载荷（offset + 新字节值） */
  const changesPayload = useMemo(
    () => Array.from(edit.edits.entries()).map(([offset, value]) => ({ offset, value })),
    [edit.edits],
  );

  /** 就地保存（临时文件 + 原子替换）。返回是否成功（供"保存并继续"流程使用） */
  const doSave = useCallback(async (): Promise<boolean> => {
    if (!fileMeta || edit.editCount === 0) return true;
    if (fileMeta.is_readonly) {
      showToast('文件为只读，请改用另存为（Ctrl+Shift+S）');
      return false;
    }
    if (ver.previewing) {
      showToast('预览历史版本中，请先返回当前内容');
      return false;
    }
    if (saving) return false;
    setSaving(true);
    try {
      const meta = await invoke<FileMeta>('save_file', { changes: changesPayload, path: null });
      edit.afterSave(); // 清覆盖层，保留撤销栈（可继续撤销到保存前）
      resetChunks(meta); // Rust 侧已重新 mmap，重载分片
      // resetChunks 只预载头部分片；用户可能停在文件中部，
      // 可视区间不会自动重新上报（未滚动/未重挂载），手动补拉
      const rb = config.bytesPerRow;
      ensureRange(visibleRange.first * rb, (visibleRange.last + 1) * rb - 1);
      showToast('已保存');
      // 自动模式：保存成功后记录一个版本（只读文件不记录；与最新版本相同则静默跳过）
      if (config.versionMode === 'auto' && !meta.is_readonly) {
        ver.recordVersion(makeVersionLabel('自动')).catch(err => console.error(err));
      }
      return true;
    } catch (err) {
      showToast(`保存失败: ${err}`);
      console.error(err);
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    fileMeta,
    edit,
    changesPayload,
    saving,
    resetChunks,
    showToast,
    config.bytesPerRow,
    config.versionMode,
    ensureRange,
    visibleRange,
    ver,
  ]);

  /** 另存为：写目标路径，当前文件与覆盖层均保持不变 */
  const doSaveAs = useCallback(async () => {
    if (!fileMeta || saving) return;
    if (ver.previewing) {
      showToast('预览历史版本中，请先返回当前内容');
      return;
    }
    try {
      const target = await saveFileDialog({ defaultPath: fileMeta.path });
      if (!target) return;
      setSaving(true);
      await invoke<FileMeta>('save_file', { changes: changesPayload, path: target });
      const name = (target as string).split(/[\\/]/).pop() ?? '新文件';
      showToast(`已另存为 ${name}`);
      // 自动模式：另存为成功同样记录当前内容为一个版本
      if (config.versionMode === 'auto' && !fileMeta.is_readonly) {
        ver.recordVersion(makeVersionLabel('自动')).catch(err => console.error(err));
      }
    } catch (err) {
      showToast(`另存为失败: ${err}`);
      console.error(err);
    } finally {
      setSaving(false);
    }
  }, [fileMeta, changesPayload, saving, config.versionMode, ver, showToast]);

  /** Ctrl+S：可选保存前确认 */
  const handleSaveShortcut = useCallback(() => {
    if (!fileMeta || edit.editCount === 0 || saving) return;
    if (config.confirmSave) setSaveConfirmOpen(true);
    else void doSave();
  }, [fileMeta, edit.editCount, saving, config.confirmSave, doSave]);

  /** 直接模式：双击字节 / Ctrl+E 进入行内编辑（光标与选择同步到该字节） */
  const handleEditStart = useCallback(
    (offset: number) => {
      if (!fileMeta) return;
      if (ver.previewing) return;
      if (fileMeta.is_readonly) {
        showToast('文件为只读，无法编辑（可另存为）');
        return;
      }
      setDirectEditOffset(offset);
      setCursorOffset(offset);
      setSelection({ start: offset, end: offset });
    },
    [fileMeta, ver.previewing, showToast],
  );

  /**
   * 编辑入口（Ctrl+E / 侧栏"开始编辑"）：按当前模式分流。
   * - 对话框模式：弹出编辑对话框，区间 = 选中区间 ?? 光标单字节
   * - 直接模式：光标处字节进入行内编辑（无对话框）
   */
  const startEdit = useCallback(() => {
    if (!fileMeta || fileMeta.size === 0) return;
    if (ver.previewing) {
      showToast('预览历史版本中，请先返回当前内容');
      return;
    }
    if (fileMeta.is_readonly) {
      showToast('文件为只读，无法编辑（可另存为）');
      return;
    }
    if (cursorOffset === null && !selection) {
      showToast('请先点击一个字节设置光标');
      return;
    }
    // 开始编辑即切到编辑选项卡（两种模式都生效），便于查看操作记录
    setActiveSidebarTab('edit');
    if (config.editMode === 'direct') {
      handleEditStart(cursorOffset ?? selection!.start);
      return;
    }
    const range =
      selection ??
      (cursorOffset !== null ? { start: cursorOffset, end: cursorOffset } : null);
    if (!range) return;
    setEditDialogRange(range);
  }, [fileMeta, config.editMode, cursorOffset, selection, handleEditStart, ver.previewing, showToast]);

  const handleEditCommit = useCallback(
    (offset: number, oldValue: number, newValue: number) => {
      setDirectEditOffset(null);
      edit.applyEdit(
        [{ offset, oldValue, newValue }],
        `@${hexOffset(offset, offsetDigits(fileMeta?.size ?? 0))} ${hexByte(oldValue)}→${hexByte(newValue)}`,
      );
    },
    [edit, fileMeta],
  );

  const handleEditCancel = useCallback(() => {
    setDirectEditOffset(null);
  }, []);

  /** 对话框"当前值"：原始内容 + 覆盖层（与视图一致） */
  const loadDialogBytes = useCallback(async () => {
    if (!editDialogRange) return new Uint8Array(0);
    const { start, end } = editDialogRange;
    const len = end - start + 1;
    const raw = await readRange(start, len);
    for (let i = 0; i < len; i++) {
      const v = edit.edits.get(start + i);
      if (v !== undefined) raw[i] = v;
    }
    return raw;
  }, [editDialogRange, readRange, edit.edits]);

  /** 对话框提交：与当前值 diff 生成 change 列表（oldValue = 覆盖层当前值） */
  const commitDialogEdit = useCallback(
    async (newBytes: Uint8Array) => {
      const range = editDialogRange;
      if (!range) return;
      setEditDialogRange(null);
      const len = range.end - range.start + 1;
      try {
        const cur = await readRange(range.start, len);
        const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
        for (let i = 0; i < len; i++) {
          const original = cur[i];
          const current = edit.edits.get(range.start + i) ?? original;
          if (current !== newBytes[i]) {
            changes.push({
              offset: range.start + i,
              oldValue: current,
              newValue: newBytes[i],
            });
          }
        }
        if (changes.length) {
          const digits = offsetDigits(fileMeta?.size ?? 0);
          const label =
            changes.length === 1
              ? `@${hexOffset(range.start, digits)} ${hexByte(changes[0].oldValue)}→${hexByte(changes[0].newValue)}`
              : `${changes.length} 字节 @${hexOffset(range.start, digits)}`;
          edit.applyEdit(changes, label);
        } else showToast('内容无变化');
      } catch (err) {
        console.error(err);
        showToast('读取当前内容失败');
      }
    },
    [editDialogRange, readRange, edit, showToast, fileMeta],
  );

  /**
   * 从操作记录撤销到指定操作：
   * - 目标即最近一次生效操作：等同于 Ctrl+Z，直接执行
   * - 更早的操作：会一并撤销其后所有操作，先弹确认
   */
  const requestUndoTo = useCallback(
    (index: number) => {
      if (index === edit.pos - 1) {
        edit.undoTo(index);
        return;
      }
      setUndoConfirmIndex(index);
    },
    [edit],
  );

  // ---------- 历史版本：记录 / 预览 / 恢复 / 删除 / 重命名 / 清理 ----------

  /** 手动记录当前内容为一个版本 */
  const handleManualRecord = useCallback(async () => {
    try {
      const saved = await ver.recordVersion(makeVersionLabel('手动'));
      showToast(saved ? '已记录版本' : '与最新版本相同，已跳过');
    } catch (err) {
      showToast(`记录版本失败: ${err}`);
      console.error(err);
    }
  }, [ver, showToast]);

  const handleTogglePreview = useCallback(
    async (id: string) => {
      try {
        await ver.togglePreview(id);
      } catch (err) {
        showToast(`载入版本失败: ${err}`);
        console.error(err);
      }
    },
    [ver, showToast],
  );

  const handleDeleteVersion = useCallback(
    async (id: string) => {
      try {
        await ver.deleteVersionById(id);
      } catch (err) {
        showToast(`删除版本失败: ${err}`);
        console.error(err);
      }
    },
    [ver, showToast],
  );

  const handleRenameVersion = useCallback(
    async (id: string, label: string) => {
      try {
        await ver.renameVersionById(id, label);
      } catch (err) {
        showToast(`重命名失败: ${err}`);
        console.error(err);
      }
    },
    [ver, showToast],
  );

  const handleCleanupVersions = useCallback(
    async (opts: CleanupOptions) => {
      try {
        const n = await ver.cleanupVersions(opts);
        showToast(n > 0 ? `已清理 ${n} 个版本` : '没有需要清理的版本');
      } catch (err) {
        showToast(`清理失败: ${err}`);
        console.error(err);
      }
    },
    [ver, showToast],
  );

  /** 恢复确认后执行：版本差异作为一个新编辑操作追加（可 Ctrl+Z 撤销） */
  const doRestoreVersion = useCallback(
    async (id: string) => {
      try {
        const { changes, skipped } = await ver.restoreVersion(id);
        if (changes === 0) {
          showToast(skipped > 0 ? `版本位置超出当前文件，已跳过 ${skipped} 处` : '当前内容与该版本一致');
        } else {
          showToast(
            skipped > 0
              ? `已恢复 ${changes} 字节（另有 ${skipped} 处超出文件已跳过）`
              : `已恢复 ${changes} 字节（可撤销）`,
          );
        }
      } catch (err) {
        showToast(`恢复版本失败: ${err}`);
        console.error(err);
      }
    },
    [ver, showToast],
  );

  // ---------- AI 助手：上下文构造 / 发送 / 停止（只读，不影响任何编辑状态） ----------

  /**
   * AI 发送流程：构造数据上下文（选中区间，无选中取光标附近 64 字节）
   * → 追加用户消息与助手占位 → 流式请求，增量批量刷新。
   * 所有错误以系统消息形式展示在对话区，不弹窗。
   */
  const handleAiSend = useCallback(
    async (text: string) => {
      if (aiGenerating || !fileMeta) return;
      const cfg = ai.config;
      if (!cfg.model.trim()) {
        aiChat.appendMessage({ role: 'system', content: '请先在 AI 配置中填写模型名称', isError: true });
        return;
      }
      if (cfg.provider === 'openai' && !cfg.apiKey.trim()) {
        aiChat.appendMessage({ role: 'system', content: '请先在 AI 配置中填写 API Key', isError: true });
        return;
      }

      const fileSize = fileMeta.size;
      /** 读取光标处字节的显示值（原始内容 + 覆盖层） */
      const readDisplayByte = async (offset: number): Promise<number | null> => {
        if (offset < 0 || offset >= fileSize) return null;
        try {
          const b = await readRange(offset, 1);
          return displayEdits.get(offset) ?? b[0];
        } catch {
          return null;
        }
      };

      let contextText: string | null = null;
      let contextMeta: { start: number; end: number; truncated: boolean } | undefined;

      try {
        if (selection) {
          const len = selection.end - selection.start + 1;
          const take = Math.min(len, cfg.maxContextBytes);
          const data = await readRange(selection.start, take);
          for (let i = 0; i < data.length; i++) {
            const v = displayEdits.get(selection.start + i);
            if (v !== undefined) data[i] = v;
          }
          contextText = buildAiContext({
            bytes: data,
            start: selection.start,
            fullLength: len,
            truncated: take < len,
            title: '选中范围',
            cursorOffset,
            cursorByte: await readDisplayByte(cursorOffset ?? -1),
            fileSize,
          });
          contextMeta = { start: selection.start, end: selection.end, truncated: take < len };
        } else if (cursorOffset !== null && fileSize > 0) {
          // 无选中：光标前后各半共 64 字节，越界时向文件内收缩
          const len = Math.min(AI_CURSOR_CONTEXT, fileSize);
          const start = Math.max(0, Math.min(cursorOffset - (len >> 1), fileSize - len));
          const data = await readRange(start, len);
          for (let i = 0; i < data.length; i++) {
            const v = displayEdits.get(start + i);
            if (v !== undefined) data[i] = v;
          }
          contextText = buildAiContext({
            bytes: data,
            start,
            fullLength: len,
            truncated: false,
            title: `光标附近 ${len} 字节`,
            cursorOffset,
            cursorByte: data[cursorOffset - start] ?? null,
            fileSize,
          });
          contextMeta = { start, end: start + len - 1, truncated: false };
        } else {
          aiChat.appendMessage({
            role: 'system',
            content: '请先选择一段字节或点击一个字节设置光标',
            isError: true,
          });
          return;
        }
      } catch (err) {
        console.error(err);
        aiChat.appendMessage({ role: 'system', content: `读取数据上下文失败: ${err}`, isError: true });
        return;
      }

      aiChat.appendMessage({
        role: 'user',
        content: text,
        contextText: contextText ?? undefined,
        context: contextMeta,
      });

      // API 消息：系统提示 + 近期对话（系统错误消息不发送；历史用户消息重新拼上其数据上下文）
      const history = [
        ...aiChat.messages.filter(m => m.role !== 'system'),
        { role: 'user' as const, content: text, contextText: contextText ?? undefined },
      ].slice(-AI_HISTORY_LIMIT);
      const apiMessages: ApiChatMessage[] = [
        ...(cfg.systemPrompt.trim() ? [{ role: 'system' as const, content: cfg.systemPrompt }] : []),
        ...history.map(m => ({
          role: m.role,
          content:
            m.role === 'user' && m.contextText ? `${m.contextText}\n\n[用户提问]\n${m.content}` : m.content,
        })),
      ];

      const asstId = aiChat.appendMessage({ role: 'assistant', content: '' });
      setAiGenerating(true);
      const controller = new AbortController();
      aiAbortRef.current = controller;

      // 增量缓冲：30ms 批量刷新，避免每个 token 触发一次渲染
      let acc = '';
      let flushTimer: number | null = null;
      let timedOut = false;
      let watchdog: number | null = null;
      const flush = () => {
        flushTimer = null;
        aiChat.updateMessage(asstId, acc);
      };
      const armWatchdog = () => {
        if (watchdog !== null) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, AI_TIMEOUT_MS);
      };

      try {
        armWatchdog();
        await streamChat(
          cfg,
          apiMessages,
          delta => {
            acc += delta;
            armWatchdog();
            if (flushTimer === null) flushTimer = window.setTimeout(flush, 30);
          },
          controller.signal,
        );
        if (flushTimer !== null) window.clearTimeout(flushTimer);
        flush();
        if (!acc) {
          aiChat.updateMessage(asstId, '[空回复]');
          console.warn('[AI] 模型返回了空内容');
        }
      } catch (err) {
        if (flushTimer !== null) window.clearTimeout(flushTimer);
        flush(); // 保留已生成部分
        if (controller.signal.aborted && !timedOut) {
          // 用户主动停止：保留已生成内容（首个增量前停止则移除空占位）
          if (!acc) aiChat.removeMessage(asstId);
        } else {
          if (!acc) aiChat.removeMessage(asstId);
          const reason = timedOut
            ? '请求超时（60 秒无响应），已中止'
            : err instanceof Error
              ? err.message
              : String(err);
          aiChat.appendMessage({ role: 'system', content: `AI 请求失败：${reason}`, isError: true });
        }
      } finally {
        if (watchdog !== null) window.clearTimeout(watchdog);
        aiAbortRef.current = null;
        setAiGenerating(false);
      }
    },
    [aiGenerating, fileMeta, ai, aiChat, selection, cursorOffset, readRange, displayEdits],
  );

  /** 停止生成：中止流式请求，保留已生成内容 */
  const handleAiStop = useCallback(() => {
    aiAbortRef.current?.abort();
  }, []);

  /** AI 选项卡徽章：当前会话消息数（用户 + AI 回复） */
  const aiCount = useMemo(
    () => aiChat.messages.reduce((n, m) => (m.role === 'system' ? n : n + 1), 0),
    [aiChat.messages],
  );

  // 切换文件时中止进行中的 AI 生成（会话按文件隔离，避免流写入其他文件的历史）
  const aiFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    const p = fileMeta?.path ?? null;
    if (aiGenerating && aiFilePathRef.current !== p) aiAbortRef.current?.abort();
    aiFilePathRef.current = p;
  }, [fileMeta, aiGenerating]);

  // 卸载时中止未完成的 AI 请求
  useEffect(() => () => aiAbortRef.current?.abort(), []);

  const handleVisibleRangeChange = useCallback(
    (startByte: number, endByte: number) => {
      ensureRange(startByte, endByte);
      const rb = config.bytesPerRow;
      setVisibleRange({
        first: Math.floor(startByte / rb),
        last: Math.floor(endByte / rb),
      });
    },
    [ensureRange, config.bytesPerRow],
  );

  // 主题同步到 :root，供 portal 到 body 的弹层（如复制编码菜单）继承主题变量
  useEffect(() => {
    document.documentElement.dataset.theme = config.theme;
  }, [config.theme]);

  // 编辑结束（行内编辑框 / 对话框卸载）后焦点会落到 body，方向键导航失效；
  // 仅在焦点仍停留在 body 时重新聚焦视图容器（用户已点击其他控件则不抢焦点）
  const prevDirectEdit = useRef<number | null>(null);
  const prevDialogRange = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    const wasEditing = prevDirectEdit.current !== null || prevDialogRange.current !== null;
    prevDirectEdit.current = directEditOffset;
    prevDialogRange.current = editDialogRange;
    if (wasEditing && directEditOffset === null && editDialogRange === null) {
      if (document.activeElement === document.body) {
        hexViewerRef.current?.focus();
      }
    }
  }, [directEditOffset, editDialogRange]);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (ctrl && key === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
      } else if (e.key === 'Escape') {
        // 弹窗打开时由弹窗自行处理 Escape；行内编辑框已 stopPropagation 不会到达这里
        if (
          editDialogRange ||
          unsavedAction ||
          saveConfirmOpen ||
          discardConfirmOpen ||
          undoConfirmIndex !== null ||
          restoreConfirmId !== null
        ) {
          return;
        }
        // 其他 portal 弹窗（如版本清理对话框）打开时，Escape 由弹窗自行处理
        if (document.querySelector('.modal')) return;
        // 预览历史版本：Escape 先退出预览
        if (ver.previewing) {
          ver.exitPreview();
          return;
        }
        if (directEditOffset !== null) {
          setDirectEditOffset(null);
          return;
        }
        setSelection(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (ctrl && key === 'c' && !inInput && selection) {
        e.preventDefault();
        // Ctrl+C 复制 Hex，Ctrl+Shift+C 按当前显示编码复制文本（预览中同样可用）
        copySelection(e.shiftKey ? 'text' : 'hex');
      } else if (ctrl && key === 'b' && !inInput) {
        // Ctrl+B 切换光标处书签；Ctrl+Shift+B 把选择转成标记（预览中禁用）
        e.preventDefault();
        if (ver.previewing) return;
        if (e.shiftKey) {
          addMarkFromSelection();
        } else if (cursorOffset !== null && fileMeta && cursorOffset < fileMeta.size) {
          toggleBookmarkAtCursor(cursorOffset);
        }
      } else if (e.key === 'F2' && !inInput) {
        // F2 下一个书签/标记，Shift+F2 上一个（按偏移循环）
        e.preventDefault();
        jumpBookmarkRelative(e.shiftKey ? -1 : 1);
      } else if (ctrl && key === 's' && !inInput) {
        // Ctrl+S 保存（可配置确认），Ctrl+Shift+S 另存为；预览中禁用
        e.preventDefault();
        if (ver.previewing) {
          showToast('预览历史版本中，请先返回当前内容');
          return;
        }
        if (e.shiftKey) void doSaveAs();
        else handleSaveShortcut();
      } else if (ctrl && (key === 'z' || key === 'y') && !inInput) {
        // Ctrl+Z 撤销最近一次，Ctrl+Y / Ctrl+Shift+Z 恢复最近一次；预览中禁用
        e.preventDefault();
        if (ver.previewing) return;
        if (key === 'y' || e.shiftKey) edit.redoLast();
        else edit.undoLast();
      } else if (ctrl && key === 'e' && !inInput) {
        // Ctrl+E 按当前模式开始编辑
        e.preventDefault();
        startEdit();
      } else if (e.key === 'Enter' && !inInput) {
        // Enter 开始编辑；弹窗打开时由弹窗处理，行内编辑框已 stopPropagation
        if (
          !editDialogRange &&
          !unsavedAction &&
          !saveConfirmOpen &&
          !discardConfirmOpen &&
          undoConfirmIndex === null &&
          restoreConfirmId === null &&
          directEditOffset === null
        ) {
          e.preventDefault();
          startEdit();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selection,
    copySelection,
    cursorOffset,
    fileMeta,
    bm,
    addMarkFromSelection,
    toggleBookmarkAtCursor,
    jumpBookmarkRelative,
    editDialogRange,
    unsavedAction,
    saveConfirmOpen,
    discardConfirmOpen,
    undoConfirmIndex,
    restoreConfirmId,
    directEditOffset,
    doSaveAs,
    handleSaveShortcut,
    edit,
    startEdit,
    ver,
    showToast,
  ]);

  // 清理计时器
  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const searchPercent =
    search.progress && search.progress.total > 0
      ? Math.floor((search.progress.searched / search.progress.total) * 100)
      : 0;

  return (
    <div className="app-container" data-theme={config.theme}>
      <Toolbar
        hasFile={!!fileMeta}
        fileName={fileMeta?.name ?? null}
        onOpenFile={handleOpenFile}
        unsaved={edit.editCount > 0}
        onCloseFile={handleCloseFile}
        searchMode={searchMode}
        setSearchMode={setSearchMode}
        searchText={searchText}
        setSearchText={setSearchText}
        caseSensitive={caseSensitive}
        setCaseSensitive={setCaseSensitive}
        onSearch={handleSearch}
        onCancelSearch={search.cancelSearch}
        searching={search.running}
        searchPercent={searchPercent}
        searchInputRef={searchInputRef}
        gotoText={gotoText}
        setGotoText={setGotoText}
        onGoto={handleGoto}
        gotoInputRef={gotoInputRef}
        config={config}
        onBytesPerRowChange={setBytesPerRow}
        onZoom={zoomFont}
        onThemeChange={setTheme}
        onToggleAscii={toggleAscii}
        onEncodingChange={setEncoding}
      />

      <div className="main-content">
        <main className="hex-display">
          {ver.previewVersion && fileMeta && (
            <div className="preview-banner" role="status">
              <span className="preview-banner-text">
                正在预览历史版本：<strong>{ver.previewVersion.label}</strong>
                <span className="preview-banner-time">
                  {' '}
                  · {fmtVersionTime(ver.previewVersion.time)}
                </span>
              </span>
              <span className="preview-banner-flex" />
              <button
                className="btn mini"
                disabled={fileMeta.is_readonly}
                title={
                  fileMeta.is_readonly
                    ? '文件为只读，无法恢复'
                    : '把该版本内容恢复为未保存修改（可撤销）'
                }
                onClick={() => ver.previewId && setRestoreConfirmId(ver.previewId)}
              >
                恢复到此版本
              </button>
              <button className="btn mini" onClick={ver.exitPreview}>
                返回当前
              </button>
            </div>
          )}
          {fileMeta ? (
            <HexViewer
              key={`${fileMeta.path}::${fileMeta.size}`}
              ref={hexViewerRef}
              meta={fileMeta}
              config={config}
              cacheVersion={cacheVersion}
              getBytes={displayGetBytes}
              onVisibleRangeChange={handleVisibleRangeChange}
              selection={selection}
              onSelectionChange={setSelection}
              hoverOffset={hoverOffset}
              onHoverOffsetChange={setHoverOffset}
              cursorOffset={cursorOffset}
              onCursorChange={setCursorOffset}
              flashOffset={flashOffset}
              onZoom={zoomFont}
              bookmarks={bm.sorted}
              edits={displayEdits}
              editMode={config.editMode}
              editTarget={directEditOffset}
              onEditStart={handleEditStart}
              onEditCommit={handleEditCommit}
              onEditCancel={handleEditCancel}
              readOnly={ver.previewing}
            />
          ) : (
            <div className="hex-viewer hex-viewer-empty">
              <div className="empty-state">
                <div className="empty-title">Hex Viewer</div>
                <div>请打开一个文件以查看内容（支持 1GB+ 大文件）</div>
              </div>
            </div>
          )}
        </main>

        <Sidebar
          activeTab={activeSidebarTab}
          onTabChange={setActiveSidebarTab}
          meta={fileMeta}
          stats={stats}
          totalRows={totalRows}
          bookmarks={bm.sorted}
          activeBookmarkId={activeBookmarkId}
          cursorOffset={cursorOffset}
          hasSelection={!!selection}
          maxBookmarkItems={bm.maxRenderItems}
          onToggleBookmark={toggleBookmarkAtCursor}
          onAddMark={addMarkFromSelection}
          onJumpToBookmark={jumpToBookmark}
          onRemoveBookmark={bm.removeBookmark}
          onUpdateBookmark={bm.updateBookmark}
          onClearBookmarks={bm.clearAll}
          search={search}
          activeHitOffset={activeHitOffset}
          onJumpToOffset={offset => {
            setActiveHitOffset(offset);
            // 点击搜索结果：选择折叠到命中位置，光标同步（jumpToOffset 内）
            setSelection({ start: offset, end: offset });
            jumpToOffset(offset);
          }}
          editMode={config.editMode}
          onEditModeChange={setEditMode}
          confirmSave={config.confirmSave}
          onConfirmSaveChange={setConfirmSave}
          editCount={edit.editCount}
          canUndo={edit.canUndo}
          canRedo={edit.canRedo}
          onUndo={edit.undoLast}
          onRedo={edit.redoLast}
          onUndoTo={requestUndoTo}
          onRedoTo={edit.redoTo}
          ops={edit.ops}
          pos={edit.pos}
          onEditSelection={startEdit}
          onDiscardAll={() => setDiscardConfirmOpen(true)}
          versionsPane={
            <SidebarVersions
              meta={fileMeta}
              mode={config.versionMode}
              onModeChange={setVersionMode}
              versions={ver.versions}
              previewId={ver.previewId}
              previewActive={ver.previewing}
              overLimit={ver.overLimit}
              globalSize={ver.globalSize}
              onRecord={handleManualRecord}
              onTogglePreview={handleTogglePreview}
              onRestore={setRestoreConfirmId}
              onDelete={handleDeleteVersion}
              onRename={handleRenameVersion}
              onCleanup={handleCleanupVersions}
            />
          }
          versionsCount={ver.versions.length}
          previewActive={ver.previewing}
          aiPane={
            <SidebarAi
              active={activeSidebarTab === 'ai'}
              hasFile={!!fileMeta}
              config={ai.config}
              onConfigChange={ai.updateConfig}
              onResetSystemPrompt={ai.resetSystemPrompt}
              messages={aiChat.messages}
              generating={aiGenerating}
              onSend={handleAiSend}
              onStop={handleAiStop}
              onClearRequest={() => setAiClearConfirmOpen(true)}
              digits={offsetDigits(fileMeta?.size ?? 0)}
            />
          }
          aiCount={aiCount}
          perf={perf}
          cacheBytes={cacheBytes}
          visibleRows={visibleRows}
        />
      </div>

      <StatusBar
        meta={fileMeta}
        hoverOffset={hoverOffset}
        cursorOffset={cursorOffset}
        selection={selection}
        rowBytes={config.bytesPerRow}
        encoding={config.encoding}
        loading={loading}
        toast={toast}
        onCopyHex={() => copySelection('hex')}
        onCopyText={encoding => copySelection('text', encoding)}
      />

      {/* 对话框编辑（Ctrl+E） */}
      {editDialogRange && fileMeta && (
        <EditDialog
          start={editDialogRange.start}
          end={editDialogRange.end}
          digits={offsetDigits(fileMeta.size)}
          loadBytes={loadDialogBytes}
          onCommit={commitDialogEdit}
          onCancel={() => setEditDialogRange(null)}
        />
      )}

      {/* 未保存三选一（打开/关闭文件前） */}
      {unsavedAction && (
        <ConfirmDialog
          title="有未保存的修改"
          message={`当前文件有 ${edit.editCount} 字节未保存修改，如何处理？`}
          buttons={[
            {
              label: '保存并继续',
              kind: 'primary',
              onClick: () => {
                const action = unsavedAction;
                setUnsavedAction(null);
                void doSave().then(ok => {
                  if (ok) proceedUnsaved(action);
                });
              },
            },
            {
              label: '放弃修改并继续',
              kind: 'danger',
              onClick: () => {
                const action = unsavedAction;
                setUnsavedAction(null);
                edit.discardUnsaved();
                proceedUnsaved(action);
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setUnsavedAction(null),
            },
          ]}
          onCancel={() => setUnsavedAction(null)}
        />
      )}

      {/* 保存前确认 */}
      {saveConfirmOpen && (
        <ConfirmDialog
          title="保存修改"
          message={`将把 ${edit.editCount} 字节修改写入 ${fileMeta?.name ?? '当前文件'}，是否继续？`}
          buttons={[
            {
              label: '保存',
              kind: 'primary',
              onClick: () => {
                setSaveConfirmOpen(false);
                void doSave();
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setSaveConfirmOpen(false),
            },
          ]}
          onCancel={() => setSaveConfirmOpen(false)}
        />
      )}

      {/* 放弃全部修改确认 */}
      {discardConfirmOpen && (
        <ConfirmDialog
          title="放弃全部修改"
          message={`将丢弃 ${edit.editCount} 字节未保存修改（不可恢复），是否继续？`}
          buttons={[
            {
              label: '放弃修改',
              kind: 'danger',
              onClick: () => {
                setDiscardConfirmOpen(false);
                edit.discardUnsaved();
                showToast('已放弃未保存的修改');
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setDiscardConfirmOpen(false),
            },
          ]}
          onCancel={() => setDiscardConfirmOpen(false)}
        />
      )}

      {/* 撤销到指定历史操作确认 */}
      {undoConfirmIndex !== null && edit.ops[undoConfirmIndex] && (
        <ConfirmDialog
          title="撤销到指定操作"
          message={`将撤销「${edit.ops[undoConfirmIndex].label}」及其后共 ${edit.pos - undoConfirmIndex} 个操作，是否继续？`}
          buttons={[
            {
              label: '撤销',
              kind: 'danger',
              onClick: () => {
                edit.undoTo(undoConfirmIndex);
                setUndoConfirmIndex(null);
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setUndoConfirmIndex(null),
            },
          ]}
          onCancel={() => setUndoConfirmIndex(null)}
        />
      )}

      {/* 恢复历史版本确认 */}
      {restoreConfirmId !== null &&
        ver.versions.find(v => v.id === restoreConfirmId) &&
        fileMeta && (
          <ConfirmDialog
            title="恢复历史版本"
            message={`将把版本「${ver.versions.find(v => v.id === restoreConfirmId)!.label}」的内容应用到当前文件（作为未保存修改，可撤销），当前的未保存修改会被覆盖，是否继续？`}
            buttons={[
              {
                label: '恢复',
                kind: 'primary',
                onClick: () => {
                  const id = restoreConfirmId;
                  setRestoreConfirmId(null);
                  void doRestoreVersion(id);
                },
              },
              {
                label: '取消',
                kind: 'plain',
                onClick: () => setRestoreConfirmId(null),
              },
            ]}
            onCancel={() => setRestoreConfirmId(null)}
          />
        )}
      {/* 清空 AI 会话确认 */}
      {aiClearConfirmOpen && (
        <ConfirmDialog
          title="清空当前会话"
          message={`将删除当前文件的 ${aiChat.messages.length} 条 AI 对话记录，是否继续？`}
          buttons={[
            {
              label: '清空',
              kind: 'danger',
              onClick: () => {
                setAiClearConfirmOpen(false);
                aiChat.clearChat();
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setAiClearConfirmOpen(false),
            },
          ]}
          onCancel={() => setAiClearConfirmOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
