import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { HexViewer, type HexViewerHandle } from './HexViewer';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { EditDialog } from './EditDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { FillDialog } from './FillDialog';
import { InsertDialog } from './InsertDialog';
import { ExportChatDialog } from './ExportChatDialog';
import { AiTemplateDialog, type TemplateInput } from './AiTemplateDialog';
import { BackupRestoreDialog } from './BackupRestoreDialog';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { DataInspector } from './DataInspector';
import { SidebarVersions } from './SidebarVersions';
import { SidebarAi } from './SidebarAi';
import { SidebarAnalyze } from './SidebarAnalyze';
import { useFileWindow } from '../hooks/useFileWindow';
import { useFileEdits, type EditOp, type StructAction } from '../hooks/useFileEdits';
import { useFileSearch, type SearchMode } from '../hooks/useFileSearch';
import { useFileStats } from '../hooks/useFileStats';
import { useFileBookmarks } from '../hooks/useFileBookmarks';
import { useFileVersions, type CleanupOptions } from '../hooks/useFileVersions';
import { useFileTemplates } from '../hooks/useFileTemplates';
import { useAiChat } from '../hooks/useAiChat';
import { useStringExtract } from '../hooks/useStringExtract';
import type { AiConfig } from '../hooks/useAiConfig';
import { streamChat, type ApiChatMessage } from '../utils/aiClient';
import { buildAiContext } from '../utils/aiContext';
import {
  isBlockSelection,
  linearToBlock,
  normalizeSelection,
} from '../utils/selection';
import type {
  AutosaveInfo,
  Bookmark,
  CommandDef,
  DisplayConfig,
  FileMeta,
  FileTabStatus,
  SaveResult,
  Selection,
  SidebarTab,
  StringHit,
  TemplateField,
  TextEncoding,
} from '../types';
import {
  fmtVersionTime,
  hexByte,
  hexOffset,
  makeVersionLabel,
  offsetDigits,
  parseOffsetInput,
} from '../utils/format';
import { decodeBytesToText, encodingLabel } from '../utils/decode';
import {
  encodeTextToBytes,
  parseHexPattern,
  validateReplace,
  type ReplaceMode,
} from '../utils/hexParse';

const MAX_COPY_BYTES = 4 * 1024 * 1024;
/** 全部替换单次命中的上限（超过提示分批，避免一次生成过大的编辑操作） */
const REPLACE_ALL_LIMIT = 5000;
/** AI 流式请求无响应超时（毫秒），每个增量重置 */
const AI_TIMEOUT_MS = 60_000;
/** 单次请求携带的历史消息上限（含当前提问，控制提示词长度） */
const AI_HISTORY_LIMIT = 20;
/** 无选中时注入光标附近的字节数 */
const AI_CURSOR_CONTEXT = 64;
/** 光标历史栈容量（后退 / 前进各自上限，不持久化） */
const HISTORY_MAX = 50;

/** 替换执行参数（工具栏输入态由 App 持有，执行时传入） */
export interface ReplaceArgs {
  mode: ReplaceMode;
  searchText: string;
  replaceText: string;
}

/** App → 标签页的命令通道（全局快捷键 / 工具栏动作转发到激活标签页） */
export interface FileTabHandle {
  focus(): void;
  runSearch(mode: SearchMode, pattern: string, caseSensitive: boolean): void;
  cancelSearch(): void;
  clearSearch(): void;
  /** 跳转输入框内容解析并跳转（非法值 toast） */
  goto(text: string): void;
  /** 就地保存，返回是否成功（供"保存并关闭"流程） */
  save(): Promise<boolean>;
  saveAs(): void;
  /** Ctrl+S：按配置决定是否弹确认 */
  saveShortcut(): void;
  startEdit(): void;
  undo(): void;
  redo(): void;
  copySelection(mode: 'hex' | 'text', encoding?: TextEncoding): void;
  paste(kind: 'hex' | 'text'): void;
  /** Insert 键：光标处弹插入对话框 */
  insert(): void;
  /** Delete 键：删除选中区间 / 光标处单字节 */
  deleteSelection(): void;
  /** Ctrl+X：剪切选中区间（复制 + 删除） */
  cut(): void;
  /** Ctrl+Shift+Insert：把剪贴板内容插入到光标处 */
  insertFromClipboard(): void;
  /** 命令面板：本文件可执行的命令列表（随状态派生） */
  listCommands(): CommandDef[];
  /** 命令面板：执行命令 */
  runCommand(id: string): void;
  toggleBookmarkAtCursor(): void;
  addMarkFromSelection(): void;
  jumpBookmarkRelative(dir: 1 | -1): void;
  replace(args: ReplaceArgs): void;
  replaceNext(args: ReplaceArgs): void;
  replaceAll(args: ReplaceArgs): void;
  /** 放弃未保存修改（"放弃并关闭"前清理 localStorage 历史残留） */
  discard(): void;
  /** Escape 分层：预览 → 行内编辑 → 清空选择 */
  escape(): void;
}

interface FileTabProps {
  tabId: string;
  /** 标签页绑定的文件路径（生命周期内不变） */
  path: string;
  active: boolean;
  // 显示配置（App 持有，全局共享）
  config: DisplayConfig;
  onZoom: (delta: number) => void;
  onEditModeChange: (m: DisplayConfig['editMode']) => void;
  onConfirmSaveChange: (v: boolean) => void;
  onVersionModeChange: (m: DisplayConfig['versionMode']) => void;
  // 数据安全设置（v1.1.5：自动备份 / 保存后校验，App 持有全局共享）
  onBackupEnabledChange: (v: boolean) => void;
  onBackupCountChange: (n: DisplayConfig['backupCount']) => void;
  onVerifySaveChange: (v: boolean) => void;
  // AI 全局配置（App 持有，跨标签页共享）
  aiConfig: AiConfig;
  onAiConfigChange: (patch: Partial<AiConfig>) => void;
  onAiResetSystemPrompt: () => void;
  // Toast：仅激活标签页接收展示（隐藏标签页传 null）
  toast: string | null;
  showToast: (msg: string) => void;
  /** 向 App 上报状态（文件名 / 编辑数 / 搜索进度 / 命中数 / 预览态） */
  onStatusChange: (tabId: string, status: FileTabStatus) => void;
  /** 打开失败（文件消失等）：App 移除标签页并提示 */
  onOpenFailed: (tabId: string, path: string, err: string) => void;
  /** 右键菜单"跳转到此偏移"：填充 App 层跳转输入框并聚焦 */
  onGotoFill: (hexText: string) => void;
}

function pathTail(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

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

/** 编辑操作标签用的内容片段（过长截断） */
function labelPart(raw: string, max = 12): string {
  return `"${raw.length > max ? raw.slice(0, max) + '…' : raw}"`;
}

/**
 * 单文件标签页：一个打开文件的完整交互单元
 * （视图 + 侧栏 + 状态栏 + 各弹窗 + 全部单文件 hooks）。
 * 未激活标签页 display:none 保留全部状态；全局动作经 FileTabHandle 转发进来。
 */
export const FileTab = memo(
  forwardRef<FileTabHandle, FileTabProps>(function FileTab(props, ref) {
    const {
      tabId,
      path,
      active,
      config,
      onZoom,
      onEditModeChange,
      onConfirmSaveChange,
      onVersionModeChange,
      onBackupEnabledChange,
      onBackupCountChange,
      onVerifySaveChange,
      aiConfig,
      onAiConfigChange,
      onAiResetSystemPrompt,
      toast,
      showToast,
      onStatusChange,
      onOpenFailed,
      onGotoFill,
    } = props;

    const {
      fileMeta,
      cacheVersion,
      cacheBytes,
      loading,
      openFile,
      resetChunks,
      ensureRange,
      getBytes,
      readRange,
      setVirtualSize,
      invalidateAll,
    } = useFileWindow(tabId);
    const search = useFileSearch(tabId, fileMeta);
    const stats = useFileStats(tabId, fileMeta);
    const bm = useFileBookmarks(fileMeta);
    const edit = useFileEdits(tabId, fileMeta);
    // 版本恢复需要读取"所见即所得"字节；该函数定义在下方（依赖 displayEdits），
    // 经 ref 解除声明顺序环，调用时始终取到最新实现
    const readDisplayRef = useRef<(offset: number, len: number) => Promise<Uint8Array>>(
      async () => new Uint8Array(0),
    );
    const ver = useFileVersions(tabId, fileMeta, {
      edits: edit.edits,
      ops: edit.ops,
      pos: edit.pos,
      applyEdit: edit.applyEdit,
      applyComposite: edit.applyComposite,
      readDisplayRange: (o, l) => readDisplayRef.current(o, l),
    });
    const aiChat = useAiChat(fileMeta);
    const strings = useStringExtract(tabId, fileMeta);
    const tpl = useFileTemplates(fileMeta?.path ?? null);

    // ---------- 显示大小（虚拟偏移语义） ----------

    /** 显示大小 = 磁盘大小 + 未保存结构编辑增量（插入 + / 删除 -） */
    const displaySize = (fileMeta?.size ?? 0) + edit.virtualDelta;
    /** 显示用元数据（大小为虚拟大小）：主视图 / 跳转 / 光标钳制 / 检查器都以它为准 */
    const displayMeta = useMemo(
      () => (fileMeta ? { ...fileMeta, size: displaySize } : null),
      [fileMeta, displaySize],
    );
    /** 偏移显示位数（按显示大小，插入足够内容后自动加宽） */
    const digits = offsetDigits(displaySize);

    const [aiGenerating, setAiGenerating] = useState(false);
    const [aiClearConfirmOpen, setAiClearConfirmOpen] = useState(false);
    const aiAbortRef = useRef<AbortController | null>(null);

    const hexViewerRef = useRef<HexViewerHandle>(null);

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

    // 填充对话框 / 插入对话框 / 右键菜单 / "从此处开始选择"锚点
    const [fillRange, setFillRange] = useState<{ start: number; end: number } | null>(null);
    /** 块选择的按行填充区间（非 null 时填充对话框以汇总形式展示） */
    const [fillBlockRanges, setFillBlockRanges] = useState<Array<[number, number]> | null>(null);
    const [insertAt, setInsertAt] = useState<number | null>(null);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; offset: number } | null>(null);
    const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);

    // v1.1.5：对话导出 / AI 生成模板 / 从备份恢复
    const [exportOpen, setExportOpen] = useState(false);
    const [templateInput, setTemplateInput] = useState<TemplateInput | null>(null);
    const [backupsOpen, setBackupsOpen] = useState(false);
    /** 待确认恢复的备份文件名 */
    const [pendingRestore, setPendingRestore] = useState<string | null>(null);
    /** 恢复进行中（防止重复提交） */
    const [restoring, setRestoring] = useState(false);

    // 编辑状态：直接模式行内编辑目标 / 对话框编辑区间 / 各确认弹窗 / 保存中
    const [directEditOffset, setDirectEditOffset] = useState<number | null>(null);
    const [editDialogRange, setEditDialogRange] = useState<{ start: number; end: number } | null>(
      null,
    );
    const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
    /** 待确认的"撤销到指定操作"目标索引 */
    const [undoConfirmIndex, setUndoConfirmIndex] = useState<number | null>(null);
    /** 待确认的"恢复历史版本"目标版本 */
    const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const flashTimerRef = useRef<number | null>(null);

    const totalRows = displaySize > 0 ? Math.ceil(displaySize / config.bytesPerRow) : 0;
    const visibleRows = Math.max(0, visibleRange.last - visibleRange.first + 1);

    // ---------- 挂载即打开文件（path 生命周期内不变） ----------

    /** 打开时检测到的崩溃恢复快照（三选一对话框） */
    const [autosavePrompt, setAutosavePrompt] = useState<AutosaveInfo | null>(null);

    useEffect(() => {
      openFile(path)
        .then(meta => {
          // 光标初始设在偏移 0；空文件不显示光标
          setCursorOffset(meta.size > 0 ? 0 : null);
          // 崩溃恢复检测：存在未保存编辑的自动保存时弹三选一
          invoke<AutosaveInfo | null>('load_autosave', { filePath: path })
            .then(info => {
              if (info && info.payload && Array.isArray(info.payload.ops) && info.payload.ops.length > 0) {
                setAutosavePrompt(info);
              }
            })
            .catch(() => {/* 检测失败不影响打开 */});
        })
        .catch(err => {
          onOpenFailed(tabId, path, String(err));
        });
    }, [openFile, path, tabId, onOpenFailed]);

    // ---------- 结构性编辑跟随（插入 / 删除 / 撤销重做后） ----------

    /** 已处理过的结构性变更纪元（epoch 单调递增，防 effect 重入） */
    const structEpochRef = useRef(0);

    useEffect(() => {
      const sc = edit.structChange;
      if (!sc || sc.epoch === structEpochRef.current) return;
      structEpochRef.current = sc.epoch;
      if (!fileMeta) return;

      // 光标 / 选择端点：穿过全部动作链式重映射（插入点之后 +N；删除区间内收缩到删除点，其后 -N）
      const remapCursor = (o: number, a: StructAction): number => {
        if (a.kind === 'insert') return o >= a.offset ? o + a.length : o;
        if (o >= a.offset + a.length) return o - a.length;
        if (o >= a.offset) return a.offset;
        return o;
      };
      const chain = (o: number): number => {
        for (const a of sc.actions) o = remapCursor(o, a);
        return o;
      };
      if (cursorOffset !== null) setCursorOffset(Math.min(chain(cursorOffset), Math.max(0, displaySize - 1)));
      if (isBlockSelection(selection)) {
        // 块选择按行列定位，结构变更后行边界已平移，语义失效 → 直接清空
        setSelection(null);
      } else if (selection) {
        const s = chain(selection.start);
        const e = chain(selection.end);
        setSelection({ start: Math.min(s, e), end: Math.min(Math.max(s, e), Math.max(0, displaySize - 1)) });
      }
      if (activeHitOffset !== null) setActiveHitOffset(null);
      if (flashOffset !== null) setFlashOffset(null);

      // 书签：点书签落在删除区间内 → 删除；其余端点按光标规则重映射
      for (const b of bm.sorted) {
        if (b.start === b.end) {
          let o: number | null = b.start;
          for (const a of sc.actions) {
            if (a.kind === 'insert') {
              if (o !== null && o >= a.offset) o += a.length;
            } else if (o !== null) {
              if (o >= a.offset + a.length) o -= a.length;
              else if (o >= a.offset) o = null;
            }
          }
          if (o === null) bm.removeBookmark(b.id);
          else if (o !== b.start) bm.updateBookmark(b.id, { start: o, end: o });
        } else {
          const s = chain(b.start);
          const e = chain(b.end);
          if (s !== b.start || e !== b.end) {
            bm.updateBookmark(b.id, { start: Math.min(s, e), end: Math.min(Math.max(s, e), Math.max(0, displaySize - 1)) });
          }
        }
      }

      // 分片缓存全量失效（字节已平移）+ 虚拟大小更新 + 重新拉取可见区
      setVirtualSize(displaySize);
      invalidateAll();
      const rb = config.bytesPerRow;
      ensureRange(visibleRange.first * rb, (visibleRange.last + 1) * rb - 1);

      // 搜索命中的偏移已过期，清空并提示重新搜索（与"替换后结果过期"一致）
      if (search.results.length > 0) {
        search.clearSearch();
        showToast('内容长度已变化，搜索结果已清空，请重新搜索');
      }
    }, [
      edit.structChange,
      fileMeta,
      displaySize,
      cursorOffset,
      selection,
      activeHitOffset,
      flashOffset,
      bm,
      setVirtualSize,
      invalidateAll,
      ensureRange,
      config.bytesPerRow,
      visibleRange,
      search,
      showToast,
    ]);

    // ---------- 崩溃恢复：编辑后防抖写盘 autosave（zstd 压缩，后端限 32 文件 / 50MB） ----------

    const autosaveTimerRef = useRef<number | null>(null);
    /** 本会话是否写入过 autosave（用于保存/放弃后精准清除） */
    const autosaveWrittenRef = useRef(false);

    useEffect(() => {
      if (!fileMeta) return;
      const snap = edit.getSnapshot();
      const hasUnsaved = snap.pos > snap.diskOps;
      if (!hasUnsaved) {
        // 与磁盘对齐（保存成功 / 放弃 / 撤销回磁盘状态）：清掉自动保存
        if (autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        if (autosaveWrittenRef.current) {
          autosaveWrittenRef.current = false;
          invoke('clear_autosave', { filePath: fileMeta.path }).catch(() => {});
        }
        return;
      }
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      const path = fileMeta.path;
      const payload = {
        ops: snap.ops,
        pos: snap.pos,
        diskOps: snap.diskOps,
        cursor: cursorOffset,
        selection,
      };
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null;
        autosaveWrittenRef.current = true;
        invoke('save_autosave', { filePath: path, payload: { time: Date.now(), payload } }).catch(
          err => console.error('自动保存失败:', err),
        );
      }, 2000);
      return () => {
        if (autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
      };
    }, [fileMeta, edit.pos, edit.diskOps, edit.getSnapshot, cursorOffset, selection]);

    // ---------- 光标历史（Alt+←/→，仅内存，不持久化） ----------

    const cursorRef = useRef<number | null>(null);
    useEffect(() => {
      cursorRef.current = cursorOffset;
    }, [cursorOffset]);
    const historyRef = useRef<{ back: number[]; forward: number[] }>({ back: [], forward: [] });

    /** 跳转到指定字节偏移（居中 + 闪烁高亮 + 光标同步 + 压入历史栈） */
    const jumpToOffset = useCallback(
      (offset: number, opts?: { noHistory?: boolean }) => {
        const size = displaySize;
        if (size === 0) return;
        const target = Math.max(0, Math.min(offset, size - 1));
        if (!opts?.noHistory) {
          const cur = cursorRef.current;
          const h = historyRef.current;
          // 有效移动才压栈（栈顶去重），跳转清空前进栈
          if (cur !== null && cur !== target) {
            if (h.back[h.back.length - 1] !== cur) h.back.push(cur);
            if (h.back.length > HISTORY_MAX) h.back.shift();
            h.forward.length = 0;
          }
        }
        setFlashOffset(target);
        setCursorOffset(target);
        hexViewerRef.current?.scrollToOffset(target);
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => setFlashOffset(null), 1200);
      },
      [displaySize],
    );

    /** Alt+←/→ 在两个栈间搬运当前位置 */
    const navigateHistory = useCallback(
      (dir: 1 | -1) => {
        const h = historyRef.current;
        const cur = cursorRef.current;
        if (dir === -1) {
          const target = h.back.pop();
          if (target === undefined) return;
          if (cur !== null && cur !== target) {
            h.forward.push(cur);
            if (h.forward.length > HISTORY_MAX) h.forward.shift();
          }
          jumpToOffset(target, { noHistory: true });
        } else {
          const target = h.forward.pop();
          if (target === undefined) return;
          if (cur !== null && cur !== target) {
            h.back.push(cur);
            if (h.back.length > HISTORY_MAX) h.back.shift();
          }
          jumpToOffset(target, { noHistory: true });
        }
      },
      [jumpToOffset],
    );

    // ---------- 书签 ----------

    /** 切换光标处书签；新建时切到书签选项卡（删除不切换） */
    const toggleBookmarkAtCursor = useCallback(
      (offset: number) => {
        if (bm.toggleBookmarkAt(offset)) setActiveSidebarTab('bookmarks');
      },
      [bm],
    );

    /** 把当前选择区间转成标记；成功后切到书签选项卡（块选择语义不明确，提示改用线性选择） */
    const addMarkFromSelection = useCallback(() => {
      if (ver.previewing) return;
      if (!selection) {
        showToast('请先选择一个区间');
        return;
      }
      if (isBlockSelection(selection)) {
        showToast('块选择不支持转为标记，请使用线性选择');
        return;
      }
      bm.addMark(selection.start, selection.end);
      setActiveSidebarTab('bookmarks');
      showToast(`已标记 ${selection.end - selection.start + 1} 字节`);
    }, [selection, bm, ver.previewing, showToast]);

    /** 跳转到书签/标记：点书签只跳转；范围标记同时选中整个区间 */
    const jumpToBookmark = useCallback(
      (target: Bookmark) => {
        const size = displaySize;
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
      [displaySize, jumpToOffset, showToast],
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

    /** 分析选项卡：点击字符串 → 跳转并选中整串 */
    const jumpToString = useCallback(
      (hit: StringHit) => {
        if (displaySize === 0) return;
        const end = Math.min(hit.offset + hit.length - 1, displaySize - 1);
        setSelection({ start: hit.offset, end });
        jumpToOffset(hit.offset);
      },
      [displaySize, jumpToOffset],
    );

    // ---------- 显示覆盖层 / 派生数据 ----------

    /** 显示用覆盖层：预览历史版本时为临时覆盖层（版本内容），否则为真实编辑覆盖层 */
    const displayEdits = useMemo(
      () => ver.previewOverlay ?? edit.edits,
      [ver.previewOverlay, edit.edits],
    );

    /** 命中偏移数组（升序，引用随结果稳定，供主视图高亮） */
    const hitOffsets = useMemo(
      () => (search.results.length > 0 ? search.results.map(r => r.offset) : null),
      [search.results],
    );

    /** 读取"所见即所得"字节（后端范围 + 显示覆盖层），供检查器/替换/填充/粘贴取旧值 */
    const readDisplayRange = useCallback(
      async (offset: number, len: number): Promise<Uint8Array> => {
        const data = await readRange(offset, len);
        for (let i = 0; i < data.length; i++) {
          const v = displayEdits.get(offset + i);
          if (v !== undefined) data[i] = v;
        }
        return data;
      },
      [readRange, displayEdits],
    );
    // 供版本恢复（useFileVersions 经 EditsApi）取最新实现
    readDisplayRef.current = readDisplayRange;

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

    /** 复制选中字节（Hex / 按指定编码解码的文本）；块选择按行拼接，行间以换行分隔 */
    const copySelection = useCallback(
      async (mode: 'hex' | 'text', encoding: TextEncoding = config.encoding) => {
        if (!selection) return;
        const { ranges, totalBytes } = normalizeSelection(selection, config.bytesPerRow, displaySize);
        if (ranges.length === 0) return;
        if (totalBytes > MAX_COPY_BYTES) {
          showToast(`选择过大（${totalBytes} 字节），上限 4MB`);
          return;
        }
        const isBlock = isBlockSelection(selection);
        try {
          // 逐区间读取并应用显示覆盖层（复制内容与视图所见一致，含版本预览）
          const lineTexts: string[] = [];
          for (const [start, end] of ranges) {
            const data = await readRange(start, end - start + 1);
            for (let i = 0; i < data.length; i++) {
              const v = displayEdits.get(start + i);
              if (v !== undefined) data[i] = v;
            }
            if (mode === 'hex') {
              const parts = new Array<string>(data.length);
              for (let i = 0; i < data.length; i++) parts[i] = hexByte(data[i]);
              lineTexts.push(parts.join(' '));
            } else {
              lineTexts.push(decodeBytesToText(data, encoding));
            }
          }
          // 线性选择为单区间（无换行）；块选择按行拼接（行间 \n）
          await writeClipboard(lineTexts.join('\n'));
          const extra = isBlock ? `（块选择 ${ranges.length} 行）` : '';
          showToast(
            `已复制 ${totalBytes} 字节${extra}（${mode === 'hex' ? 'Hex' : `${encodingLabel(encoding)} 文本`}）`,
          );
        } catch (err) {
          console.error(err);
          showToast('复制失败');
        }
      },
      [selection, readRange, showToast, config.encoding, config.bytesPerRow, displaySize, displayEdits],
    );

    // ---------- 编辑：覆盖层应用 / 保存 / 编辑入口 ----------

    /** 覆盖层 → 后端保存载荷（offset + 新字节值） */
    const changesPayload = useMemo(
      () => Array.from(edit.edits.entries()).map(([offset, value]) => ({ offset, value })),
      [edit.edits],
    );

    /** 就地保存（自动备份 → 临时文件 → 原子替换 → SHA-256 校验）。返回是否成功（供"保存并关闭"流程使用） */
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
        const result = await invoke<SaveResult>('save_file', {
          tabId,
          changes: changesPayload,
          path: null,
          backupCount: config.backupEnabled ? config.backupCount : 0,
          verify: config.verifySave,
        });
        edit.afterSave(); // 清覆盖层，保留撤销栈（可继续撤销到保存前）
        resetChunks(result.meta); // Rust 侧已重新 mmap，重载分片
        // resetChunks 只预载头部分片；用户可能停在文件中部，
        // 可视区间不会自动重新上报（未滚动/未重挂载），手动补拉
        const rb = config.bytesPerRow;
        ensureRange(visibleRange.first * rb, (visibleRange.last + 1) * rb - 1);
        // 立即清除崩溃恢复快照（不等防抖 effect），避免"已保存但快照未清"的窗口
        invoke('clear_autosave', { filePath: path }).catch(() => {});
        // 校验结论反馈：通过 → 校验通过；关闭校验 → 普通"已保存"
        showToast(
          config.verifySave ? '已保存（SHA-256 校验通过）' : '已保存',
        );
        // 自动模式：保存成功后记录一个版本（只读文件不记录；与最新版本相同则静默跳过）
        if (config.versionMode === 'auto' && !result.meta.is_readonly) {
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
      config.backupEnabled,
      config.backupCount,
      config.verifySave,
      ensureRange,
      visibleRange,
      ver,
      tabId,
    ]);

    /** 另存为：写目标路径，当前文件与覆盖层均保持不变（不触发自动备份；校验目标文件） */
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
        await invoke<SaveResult>('save_file', {
          tabId,
          changes: changesPayload,
          path: target,
          backupCount: 0, // 另存为不覆盖任何旧文件，不做备份
          verify: config.verifySave,
        });
        const name = (target as string).split(/[\\/]/).pop() ?? '新文件';
        showToast(config.verifySave ? `已另存为 ${name}（校验通过）` : `已另存为 ${name}`);
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
    }, [fileMeta, changesPayload, saving, config.versionMode, config.verifySave, ver, showToast, tabId]);

    /** Ctrl+S：可选保存前确认 */
    const handleSaveShortcut = useCallback(() => {
      if (!fileMeta || edit.editCount === 0 || saving) return;
      if (ver.previewing) {
        showToast('预览历史版本中，请先返回当前内容');
        return;
      }
      if (config.confirmSave) setSaveConfirmOpen(true);
      else void doSave();
    }, [fileMeta, edit.editCount, saving, ver.previewing, config.confirmSave, doSave]);

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
      if (!fileMeta || displaySize === 0) return;
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
        // 块选择不提供单字节起点，退回光标处
        handleEditStart(cursorOffset ?? (selection && !isBlockSelection(selection) ? selection.start : null) ?? 0);
        return;
      }
      const range = isBlockSelection(selection)
        ? // 块选择的"区间编辑"语义不明确：编辑光标处单字节
          cursorOffset !== null
          ? { start: cursorOffset, end: cursorOffset }
          : null
        : selection ?? (cursorOffset !== null ? { start: cursorOffset, end: cursorOffset } : null);
      if (!range) return;
      setEditDialogRange(range);
    }, [fileMeta, displaySize, config.editMode, cursorOffset, selection, handleEditStart, ver.previewing, showToast]);

    const handleEditCommit = useCallback(
      (offset: number, oldValue: number, newValue: number) => {
        setDirectEditOffset(null);
        edit.applyEdit(
          [{ offset, oldValue, newValue }],
          `@${hexOffset(offset, digits)} ${hexByte(oldValue)}→${hexByte(newValue)}`,
        );
      },
      [edit, digits],
    );

    const handleEditCancel = useCallback(() => {
      setDirectEditOffset(null);
    }, []);

    // ---------- 查找替换 / 填充 / 粘贴 ----------

    /** 可编辑判定（替换 / 填充 / 粘贴 / 插入 / 删除共用；按显示大小判定） */
    const canEditNow =
      !!fileMeta && displaySize > 0 && !fileMeta.is_readonly && !ver.previewing;

    /** 当前活跃命中：侧栏选择 > 光标所在命中 > 无 */
    const getActiveHit = useCallback(
      (searchLen: number) => {
        const rs = search.results;
        if (rs.length === 0) return null;
        if (activeHitOffset !== null) {
          const h = rs.find(r => r.offset === activeHitOffset);
          if (h) return h;
        }
        const cur = cursorOffset;
        if (cur !== null && searchLen > 0) {
          const h = rs.find(r => cur >= r.offset && cur < r.offset + searchLen);
          if (h) return h;
        }
        return null;
      },
      [search.results, activeHitOffset, cursorOffset],
    );

    /** 替换当前活跃命中；完成后结果过期，清空并提示重新搜索 */
    const doReplace = useCallback(
      async (args: ReplaceArgs) => {
        if (!canEditNow) {
          showToast(ver.previewing ? '预览历史版本中，请先返回当前内容' : '当前文件不可编辑');
          return;
        }
        const v = validateReplace(args.mode, args.searchText, args.replaceText);
        if (!v.ok || !v.replaceBytes) {
          if (v.hint) showToast(v.hint);
          return;
        }
        if (search.running) return;
        const hit = getActiveHit(v.searchLen);
        if (!hit) {
          showToast('请先在搜索结果中选择一个命中');
          return;
        }
        const old = await readDisplayRange(hit.offset, v.replaceBytes.length);
        const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
        for (let i = 0; i < v.replaceBytes.length; i++) {
          if (old[i] !== v.replaceBytes[i]) {
            changes.push({ offset: hit.offset + i, oldValue: old[i], newValue: v.replaceBytes[i] });
          }
        }
        if (changes.length === 0) {
          showToast('内容无变化（替换值与当前值相同）');
          return;
        }
        edit.applyEdit(
          changes,
          `替换 @${hexOffset(hit.offset, digits)} ${labelPart(args.searchText)}→${labelPart(args.replaceText)}`,
        );
        search.clearSearch();
        setActiveHitOffset(null);
        showToast('已替换，内容已变更，请重新搜索');
      },
      [canEditNow, ver.previewing, search, getActiveHit, readDisplayRange, edit, digits, showToast],
    );

    /** 替换下一个：先替换当前，再跳到下一个命中（结果保留，其余命中仍有效） */
    const doReplaceNext = useCallback(
      async (args: ReplaceArgs) => {
        if (!canEditNow) {
          showToast(ver.previewing ? '预览历史版本中，请先返回当前内容' : '当前文件不可编辑');
          return;
        }
        const v = validateReplace(args.mode, args.searchText, args.replaceText);
        if (!v.ok || !v.replaceBytes) {
          if (v.hint) showToast(v.hint);
          return;
        }
        if (search.running) return;
        const rs = search.results;
        const hit = getActiveHit(v.searchLen);
        if (!hit) {
          showToast('请先在搜索结果中选择一个命中');
          return;
        }
        const old = await readDisplayRange(hit.offset, v.replaceBytes.length);
        const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
        for (let i = 0; i < v.replaceBytes.length; i++) {
          if (old[i] !== v.replaceBytes[i]) {
            changes.push({ offset: hit.offset + i, oldValue: old[i], newValue: v.replaceBytes[i] });
          }
        }
        if (changes.length > 0) {
          edit.applyEdit(
            changes,
            `替换 @${hexOffset(hit.offset, digits)} ${labelPart(args.searchText)}→${labelPart(args.replaceText)}`,
          );
        }
        const idx = rs.findIndex(r => r.offset === hit.offset);
        const next = rs[(idx + 1) % rs.length];
        if (next) {
          setActiveHitOffset(next.offset);
          jumpToOffset(next.offset);
        }
      },
      [
        canEditNow,
        ver.previewing,
        search,
        getActiveHit,
        readDisplayRange,
        edit,
        digits,
        jumpToOffset,
        showToast,
      ],
    );

    /** 全部替换：合并相邻命中分块读取，一条 EditOp 整体撤销 */
    const doReplaceAll = useCallback(
      async (args: ReplaceArgs) => {
        if (!canEditNow) {
          showToast(ver.previewing ? '预览历史版本中，请先返回当前内容' : '当前文件不可编辑');
          return;
        }
        const v = validateReplace(args.mode, args.searchText, args.replaceText);
        if (!v.ok || !v.replaceBytes) {
          if (v.hint) showToast(v.hint);
          return;
        }
        const { searchLen, replaceBytes } = v;
        if (search.running) return;
        const rs = search.results;
        if (rs.length === 0) {
          showToast('请先搜索');
          return;
        }
        if (rs.length > REPLACE_ALL_LIMIT) {
          showToast(`命中过多（${rs.length} 处），建议分批替换`);
          return;
        }
        // 相邻（间距 ≤8 字节）命中合并成块读取，减少后端调用
        const merged: Array<{ start: number; end: number; hits: number[] }> = [];
        for (const r of rs) {
          const last = merged[merged.length - 1];
          if (last && r.offset <= last.end + 8) {
            last.end = Math.max(last.end, r.offset + searchLen);
            last.hits.push(r.offset);
          } else {
            merged.push({ start: r.offset, end: r.offset + searchLen, hits: [r.offset] });
          }
        }
        const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
        let replacedCount = 0;
        try {
          for (const m of merged) {
            const data = await readDisplayRange(m.start, m.end - m.start);
            for (const off of m.hits) {
              let changed = false;
              for (let i = 0; i < searchLen; i++) {
                const oldV = data[off - m.start + i];
                if (oldV !== replaceBytes[i]) {
                  changes.push({ offset: off + i, oldValue: oldV, newValue: replaceBytes[i] });
                  changed = true;
                }
              }
              if (changed) replacedCount++;
            }
          }
        } catch (err) {
          console.error(err);
          showToast('读取当前内容失败');
          return;
        }
        if (changes.length === 0) {
          showToast('内容无变化');
          return;
        }
        edit.applyEdit(
          changes,
          `替换全部 ${labelPart(args.searchText)}→${labelPart(args.replaceText)}（${replacedCount} 处）`,
        );
        search.clearSearch();
        setActiveHitOffset(null);
        showToast(`已替换 ${replacedCount} 处，可 Ctrl+Z 撤销`);
      },
      [canEditNow, ver.previewing, search, readDisplayRange, edit, showToast],
    );

    /** 填充入口：校验后弹对话框（无选中时提示；块选择按行填充） */
    const startFill = useCallback(() => {
      if (!fileMeta || displaySize === 0) return;
      if (ver.previewing) {
        showToast('预览历史版本中，请先返回当前内容');
        return;
      }
      if (fileMeta.is_readonly) {
        showToast('文件为只读');
        return;
      }
      if (!selection) {
        showToast('请先选择要填充的区间');
        return;
      }
      if (isBlockSelection(selection)) {
        const { ranges, totalBytes } = normalizeSelection(selection, config.bytesPerRow, displaySize);
        if (ranges.length === 0 || totalBytes === 0) {
          showToast('块选择范围为空');
          return;
        }
        setFillBlockRanges(ranges);
        setFillRange({ start: ranges[0][0], end: ranges[ranges.length - 1][1] });
        return;
      }
      setFillBlockRanges(null);
      setFillRange({ start: selection.start, end: selection.end });
    }, [fileMeta, displaySize, selection, config.bytesPerRow, ver.previewing, showToast]);

    /** 填充提交：跳过已等于填充值的字节；块选择逐行区间作用，一条操作整体撤销 */
    const commitFill = useCallback(
      async (value: number) => {
        const range = fillRange;
        const blockRanges = fillBlockRanges;
        setFillRange(null);
        setFillBlockRanges(null);
        if (!range) return;
        const ranges: Array<[number, number]> = blockRanges ?? [[range.start, range.end]];
        try {
          const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
          let filled = 0;
          for (const [start, end] of ranges) {
            const len = end - start + 1;
            const old = await readDisplayRange(start, len);
            for (let i = 0; i < len; i++) {
              if (old[i] !== value) {
                changes.push({ offset: start + i, oldValue: old[i], newValue: value });
                filled++;
              }
            }
          }
          if (changes.length === 0) {
            showToast('内容无变化（区间已是该值）');
            return;
          }
          const total = ranges.reduce((n, [s, e]) => n + (e - s + 1), 0);
          edit.applyEdit(
            changes,
            ranges.length > 1
              ? `块填充 ${ranges.length} 行 = ${hexByte(value)}（${filled} 字节）`
              : `填充 @${hexOffset(range.start, digits)}–${hexOffset(range.end, digits)} = ${hexByte(value)}（${total} 字节）`,
          );
        } catch (err) {
          console.error(err);
          showToast('读取当前内容失败');
        }
      },
      [fillRange, fillBlockRanges, readDisplayRange, edit, digits, showToast],
    );

    /**
     * 粘贴（等长覆盖）：从剪贴板读文本 → Hex 解析 / 按显示编码编码为字节，
     * 写入目标位置开始的连续 N 字节，超出文件末尾截断。
     */
    const pasteFromClipboard = useCallback(
      async (kind: 'hex' | 'text', targetOverride?: number) => {
        if (!fileMeta || displaySize === 0) return;
        if (ver.previewing) {
          showToast('预览历史版本中，请先返回当前内容');
          return;
        }
        if (fileMeta.is_readonly) {
          showToast('文件为只读');
          return;
        }
        const target =
          targetOverride ??
          cursorOffset ??
          (selection && !isBlockSelection(selection) ? selection.start : null);
        if (target === null) {
          showToast('请先点击一个字节设置光标');
          return;
        }
        let text: string;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          showToast('读取剪贴板失败');
          return;
        }
        if (!text) {
          showToast('剪贴板为空');
          return;
        }
        const bytes =
          kind === 'hex' ? parseHexPattern(text) : encodeTextToBytes(text, config.encoding);
        if (!bytes || bytes.length === 0) {
          showToast(
            kind === 'hex' ? '剪贴板内容不是有效的 Hex 字符串' : '剪贴板内容无法编码为字节',
          );
          return;
        }
        const maxLen = displaySize - target;
        if (maxLen <= 0) {
          showToast('目标位置已到文件末尾');
          return;
        }
        const take = Math.min(bytes.length, maxLen);
        const truncated = take < bytes.length;
        const old = await readDisplayRange(target, take);
        const changes: Array<{ offset: number; oldValue: number; newValue: number }> = [];
        for (let i = 0; i < take; i++) {
          if (old[i] !== bytes[i]) {
            changes.push({ offset: target + i, oldValue: old[i], newValue: bytes[i] });
          }
        }
        if (changes.length > 0) {
          edit.applyEdit(
            changes,
            `粘贴 @${hexOffset(target, digits)}（${take} 字节）`,
          );
        } else if (!truncated) {
          showToast('内容无变化');
        }
        if (truncated) showToast('粘贴内容超出文件末尾，已截断');
      },
      [fileMeta, displaySize, digits, ver.previewing, cursorOffset, selection, config.encoding, readDisplayRange, edit, showToast],
    );

    // ---------- 插入 / 删除 / 剪切（可变长度编辑） ----------

    /** 结构编辑前置校验（插入 / 删除 / 剪切共用提示），返回 false 时已提示 */
    const checkStructEditable = useCallback((): boolean => {
      if (!fileMeta) return false;
      if (fileMeta.is_readonly) {
        showToast('文件为只读，无法编辑（可另存为）');
        return false;
      }
      if (ver.previewing) {
        showToast('预览历史版本中，请先返回当前内容');
        return false;
      }
      return true;
    }, [fileMeta, ver.previewing, showToast]);

    /** 插入入口（Insert 键 / 侧栏按钮 / 右键菜单）：在光标/选择起点前弹插入对话框 */
    const startInsert = useCallback(() => {
      if (!checkStructEditable()) return;
      const at = (selection && !isBlockSelection(selection) ? selection.start : null) ?? cursorOffset;
      if (at === null || at === undefined) {
        showToast('请先点击一个字节设置插入点');
        return;
      }
      setInsertAt(Math.max(0, Math.min(at, displaySize)));
      setActiveSidebarTab('edit');
    }, [checkStructEditable, selection, cursorOffset, displaySize, showToast]);

    /** 插入提交：新字节插在指定偏移之前（可 Ctrl+Z 撤销） */
    const commitInsert = useCallback(
      (bytes: number[], source: string) => {
        const at = insertAt;
        setInsertAt(null);
        if (at === null || bytes.length === 0) return;
        edit.applyInsert(at, bytes, `插入 @${hexOffset(at, digits)}（${bytes.length} 字节，${source}）`);
        showToast(`已插入 ${bytes.length} 字节（可撤销）`);
      },
      [insertAt, edit, digits, showToast],
    );

    /** 删除区间（Delete 键 / 侧栏按钮 / 右键菜单）：选中区间或光标处单字节；块选择逐行删除（一条复合操作整体撤销） */
    const doDeleteRange = useCallback(async () => {
      if (!checkStructEditable()) return;
      if (displaySize === 0) return;
      if (isBlockSelection(selection)) {
        const { ranges, totalBytes } = normalizeSelection(selection, config.bytesPerRow, displaySize);
        if (ranges.length === 0) return;
        try {
          // 被删内容从当前显示状态读取（原坐标空间），随后按升序 + 偏移前移的方式
          // 构造复合操作：每个删除的 offset 扣除其前面区间已删除的字节数。
          // 这样前向应用（IPC 顺序）与撤销反演（逆序插入）都在正确的坐标空间中。
          const inner: EditOp[] = [];
          let shift = 0;
          for (const [s, e] of ranges) {
            const data = await readDisplayRange(s, e - s + 1);
            inner.push({
              id: `blk-${s}-${inner.length}`,
              label: '',
              time: 0,
              kind: 'delete' as const,
              offset: s - shift,
              bytes: Array.from(data),
            });
            shift += e - s + 1;
          }
          edit.applyComposite(inner, `块删除 ${ranges.length} 行（${totalBytes} 字节）`);
          setSelection(null);
          showToast(`已删除 ${totalBytes} 字节（可撤销）`);
        } catch (err) {
          console.error(err);
          showToast('读取被删内容失败');
        }
        return;
      }
      const range =
        selection ?? (cursorOffset !== null ? { start: cursorOffset, end: cursorOffset } : null);
      if (!range) {
        showToast('请先点击一个字节或选择区间');
        return;
      }
      const len = range.end - range.start + 1;
      try {
        const deleted = await readDisplayRange(range.start, len);
        edit.applyDelete(
          range.start,
          Array.from(deleted),
          `删除 @${hexOffset(range.start, digits)}（${len} 字节）`,
        );
        setSelection(null);
        showToast(`已删除 ${len} 字节（可撤销）`);
      } catch (err) {
        console.error(err);
        showToast('读取被删内容失败');
      }
    }, [checkStructEditable, displaySize, selection, config.bytesPerRow, cursorOffset, readDisplayRange, edit, digits, showToast]);

    /** 剪切（Ctrl+X）：复制选中区间（Hex）后删除该区间；块选择按行复制 + 逐行删除 */
    const doCut = useCallback(async () => {
      if (!checkStructEditable()) return;
      if (!selection) {
        showToast('请先选择要剪切的区间');
        return;
      }
      if (isBlockSelection(selection)) {
        const { ranges, totalBytes } = normalizeSelection(selection, config.bytesPerRow, displaySize);
        if (ranges.length === 0) return;
        if (totalBytes > MAX_COPY_BYTES) {
          showToast(`选择过大（${totalBytes} 字节），上限 4MB`);
          return;
        }
        try {
          const lineTexts: string[] = [];
          for (const [s, e] of ranges) {
            const data = await readDisplayRange(s, e - s + 1);
            const parts = new Array<string>(data.length);
            for (let i = 0; i < data.length; i++) parts[i] = hexByte(data[i]);
            lineTexts.push(parts.join(' '));
          }
          await writeClipboard(lineTexts.join('\n'));
          // 与块删除一致的坐标空间约定：升序 + 偏移前移，撤销反演自然成立
          const inner: EditOp[] = [];
          let shift = 0;
          for (const [s, e] of ranges) {
            const data = await readDisplayRange(s, e - s + 1);
            inner.push({
              id: `blkcut-${s}-${inner.length}`,
              label: '',
              time: 0,
              kind: 'delete' as const,
              offset: s - shift,
              bytes: Array.from(data),
            });
            shift += e - s + 1;
          }
          edit.applyComposite(inner, `块剪切 ${ranges.length} 行（${totalBytes} 字节）`);
          setSelection(null);
          showToast(`已剪切 ${totalBytes} 字节（块选择 ${ranges.length} 行，可撤销）`);
        } catch (err) {
          console.error(err);
          showToast('剪切失败');
        }
        return;
      }
      const len = selection.end - selection.start + 1;
      if (len > MAX_COPY_BYTES) {
        showToast(`选择过大（${len} 字节），上限 4MB`);
        return;
      }
      try {
        const data = await readDisplayRange(selection.start, len);
        const parts = new Array<string>(data.length);
        for (let i = 0; i < data.length; i++) parts[i] = hexByte(data[i]);
        await writeClipboard(parts.join(' '));
        edit.applyDelete(
          selection.start,
          Array.from(data),
          `剪切 @${hexOffset(selection.start, digits)}（${len} 字节）`,
        );
        setSelection(null);
        showToast(`已剪切 ${len} 字节（可撤销）`);
      } catch (err) {
        console.error(err);
        showToast('剪切失败');
      }
    }, [checkStructEditable, selection, config.bytesPerRow, displaySize, readDisplayRange, edit, digits, showToast]);

    /** 从剪贴板插入（Ctrl+Shift+Insert）：Hex 优先解析，失败按显示编码当文本 */
    const doInsertFromClipboard = useCallback(async () => {
      if (!checkStructEditable()) return;
      const at =
        cursorOffset ?? (selection && !isBlockSelection(selection) ? selection.start : null);
      if (at === null) {
        showToast('请先点击一个字节设置插入点');
        return;
      }
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showToast('读取剪贴板失败');
        return;
      }
      if (!text) {
        showToast('剪贴板为空');
        return;
      }
      const bytes = parseHexPattern(text) ?? encodeTextToBytes(text, config.encoding);
      if (!bytes || bytes.length === 0) {
        showToast('剪贴板内容无法解析为字节');
        return;
      }
      const list = Array.from(bytes);
      edit.applyInsert(at, list, `插入 @${hexOffset(at, digits)}（剪贴板，${list.length} 字节）`);
      showToast(`已插入 ${list.length} 字节（可撤销）`);
    }, [checkStructEditable, cursorOffset, selection, config.encoding, edit, digits, showToast]);

    // ---------- 右键菜单 ----------

    /** 主视图右键：定位字节偏移（偏移列 → 行首字节）后弹菜单 */
    const openContextMenu = useCallback((e: React.MouseEvent, offset: number | null) => {
      if (offset === null) return;
      setCtxMenu({ x: e.clientX, y: e.clientY, offset });
    }, []);

    /** 右键菜单条目（启用/禁用随当前状态派生） */
    const ctxEntries = useMemo<ContextMenuEntry[]>(() => {
      if (!ctxMenu) return [];
      const off = ctxMenu.offset;
      const editable = !!fileMeta && displaySize > 0 && !fileMeta.is_readonly && !ver.previewing;
      const hasSel = selection !== null;
      const pointBm = bm.sorted.find(b => b.start === off && b.end === off);
      const item = (
        key: string,
        label: string,
        onSelect: () => void,
        disabled = false,
      ): ContextMenuEntry => ({ key, item: { key, label, onSelect, disabled } });
      return [
        item('copyHex', '复制 Hex', () => void copySelection('hex'), !hasSel),
        item('copyText', '复制文本', () => void copySelection('text'), !hasSel),
        item('pasteHex', '粘贴 Hex', () => void pasteFromClipboard('hex', off), !editable),
        item('pasteText', '粘贴文本', () => void pasteFromClipboard('text', off), !editable),
        { key: 'sep1', sep: true },
        item('editByte', '编辑此字节', () => {
          // 按当前编辑模式分流（与 startEdit 一致）
          setActiveSidebarTab('edit');
          if (config.editMode === 'direct') {
            handleEditStart(off);
          } else {
            setEditDialogRange({ start: off, end: off });
          }
        }, !editable),
        item('fill', '填充选中区间', startFill, !editable || !hasSel),
        item('insert', '在此处插入字节', () => {
          setSelection(null);
          setCursorOffset(off);
          startInsert();
        }, !editable),
        item('insertClip', '在此处插入剪贴板内容', () => {
          setSelection(null);
          setCursorOffset(off);
          void doInsertFromClipboard();
        }, !editable),
        item('delete', '删除选中区间', () => void doDeleteRange(), !editable),
        item('cut', '剪切选中区间', () => void doCut(), !editable || !hasSel),
        { key: 'sep2', sep: true },
        pointBm
          ? item('delBm', '删除此处书签', () => bm.removeBookmark(pointBm.id))
          : item('addBm', '在此处加书签', () => {
              bm.toggleBookmarkAt(off);
              setActiveSidebarTab('bookmarks');
            }),
        item('mark', '把选中区间标为标记', addMarkFromSelection, !hasSel),
        { key: 'sep3', sep: true },
        item('goto', '跳转到此偏移', () => {
          onGotoFill(`0x${hexOffset(off, digits)}`);
        }, !fileMeta || displaySize === 0),
        item('selFrom', '从此处开始选择', () => {
          setSelectionAnchor(off);
          showToast('已设置选择起点，点击另一字节完成选择');
        }, !fileMeta || displaySize === 0),
        item(
          'toBlock',
          '把选择转为块选择',
          () => {
            if (selection && !isBlockSelection(selection)) {
              setSelection(linearToBlock(selection, config.bytesPerRow));
              showToast('已转为块选择（Alt+方向键扩展，Escape 清空）');
            }
          },
          !selection || isBlockSelection(selection),
        ),
        { key: 'sep4', sep: true },
        item('ai', 'AI 分析选中内容', () => {
          setActiveSidebarTab('ai');
          showToast('已切换到 AI 助手，直接发送即可分析选中内容');
        }, !hasSel),
      ];
    }, [
      ctxMenu,
      fileMeta,
      displaySize,
      digits,
      selection,
      ver.previewing,
      bm,
      copySelection,
      pasteFromClipboard,
      startFill,
      startInsert,
      doInsertFromClipboard,
      doDeleteRange,
      doCut,
      addMarkFromSelection,
      config.editMode,
      config.bytesPerRow,
      handleEditStart,
      showToast,
      onGotoFill,
    ]);

    // ---------- 对话框编辑 ----------

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
      [editDialogRange, readRange, edit, digits, showToast],
    );

    /** 从操作记录撤销到指定操作：目标即最近一次直接执行，更早的先弹确认 */
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

    // ---------- 历史版本 ----------

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
          const { changes, skipped, structural } = await ver.restoreVersion(id);
          if (structural) {
            showToast(`已恢复版本内容（长度有变化，可撤销）`);
          } else if (changes === 0) {
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

    // ---------- AI 助手（只读，不影响任何编辑状态） ----------

    /**
     * AI 发送流程：构造数据上下文（选中区间，无选中取光标附近 64 字节）
     * → 追加用户消息与助手占位 → 流式请求，增量批量刷新。
     * 所有错误以系统消息形式展示在对话区，不弹窗。
     */
    const handleAiSend = useCallback(
      async (text: string) => {
        if (aiGenerating || !fileMeta) return;
        const cfg = aiConfig;
        if (!cfg.model.trim()) {
          aiChat.appendMessage({ role: 'system', content: '请先在 AI 配置中填写模型名称', isError: true });
          return;
        }
        if (cfg.provider === 'openai' && !cfg.apiKey.trim()) {
          aiChat.appendMessage({ role: 'system', content: '请先在 AI 配置中填写 API Key', isError: true });
          return;
        }

        const fileSize = displaySize;
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
            const { ranges, totalBytes } = normalizeSelection(selection, config.bytesPerRow, displaySize);
            if (ranges.length === 0) throw new Error('选择范围为空');
            const isBlock = isBlockSelection(selection);
            const take = Math.min(totalBytes, cfg.maxContextBytes);
            // 逐区间读取（块选择按行裁剪），顺序拼接为上下文
            const data = new Uint8Array(take);
            let filled = 0;
            for (const [s, e] of ranges) {
              if (filled >= take) break;
              const n = Math.min(e - s + 1, take - filled);
              const part = await readRange(s, n);
              for (let i = 0; i < part.length; i++) {
                const v = displayEdits.get(s + i);
                if (v !== undefined) part[i] = v;
              }
              data.set(part, filled);
              filled += n;
            }
            const first = ranges[0][0];
            const last = ranges[ranges.length - 1][1];
            contextText = buildAiContext({
              bytes: data,
              start: first,
              fullLength: totalBytes,
              truncated: take < totalBytes,
              title: isBlock ? `块选择（${ranges.length} 行按行拼接）` : '选中范围',
              cursorOffset,
              cursorByte: await readDisplayByte(cursorOffset ?? -1),
              fileSize,
            });
            contextMeta = { start: first, end: last, truncated: take < totalBytes };
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
      [aiGenerating, fileMeta, displaySize, aiConfig, aiChat, selection, cursorOffset, readRange, displayEdits, config.bytesPerRow],
    );

    /** 停止生成：中止流式请求，保留已生成内容 */
    const handleAiStop = useCallback(() => {
      aiAbortRef.current?.abort();
    }, []);

    // ---------- AI 生成模板（v1.1.5） ----------

    /** 打开模板对话框：组装输入（线性选中区间 ≤4KB；无选中取光标附近 64 字节） */
    const openTemplateDialog = useCallback(async () => {
      if (aiGenerating) {
        showToast('AI 正在生成中，请稍候');
        return;
      }
      if (!fileMeta || displaySize === 0) return;
      try {
        let start: number;
        let len: number;
        let fullLength: number;
        if (selection && !isBlockSelection(selection)) {
          start = selection.start;
          fullLength = selection.end - selection.start + 1;
          len = Math.min(fullLength, 4096);
        } else if (cursorOffset !== null) {
          len = Math.min(64, displaySize);
          start = Math.max(0, Math.min(cursorOffset - (len >> 1), displaySize - len));
          fullLength = len;
        } else {
          showToast('请先选择一段字节或点击一个字节设置光标');
          return;
        }
        const bytes = await readDisplayRange(start, len);
        setTemplateInput({
          bytes,
          start,
          fullLength,
          truncated: len < fullLength,
          fileSize: displaySize,
        });
      } catch (err) {
        console.error(err);
        showToast('读取模板输入数据失败');
      }
    }, [aiGenerating, fileMeta, displaySize, selection, cursorOffset, readDisplayRange, showToast]);

    /** 应用模板字段：相对偏移换算为绝对偏移，按配色写入字段标记（书签列表"模板字段"分组） */
    const applyTemplateFields = useCallback(
      (fields: Array<TemplateField & { color: string }>) => {
        if (!templateInput || !fileMeta) return;
        const applied = fields
          .map(f => ({
            name: f.name,
            start: templateInput.start + f.offset,
            end: Math.min(templateInput.start + f.offset + f.length - 1, displaySize - 1),
            color: f.color,
          }))
          .filter(f => f.start < displaySize && f.end >= f.start);
        if (applied.length === 0) {
          showToast('没有可应用的字段（偏移超出文件末尾）');
          return;
        }
        bm.addFields(applied);
        setTemplateInput(null);
        setActiveSidebarTab('bookmarks');
        showToast(`已应用 ${applied.length} 个模板字段（见书签列表"模板字段"）`);
      },
      [templateInput, fileMeta, displaySize, bm, showToast],
    );

    /** 记录一次模板生成到 AI 对话历史（保持会话完整，可回溯） */
    const recordTemplateExchange = useCallback(
      (description: string, output: string) => {
        aiChat.appendMessage({ role: 'user', content: `生成模板：${description}` });
        aiChat.appendMessage({ role: 'assistant', content: output });
      },
      [aiChat],
    );

    // ---------- 从备份恢复（v1.1.5） ----------

    /** 选中一份备份：关闭列表，弹出覆盖确认 */
    const handlePickBackup = useCallback((backupName: string) => {
      setBackupsOpen(false);
      setPendingRestore(backupName);
    }, []);

    /** 确认恢复：丢弃未保存编辑 → 后端归档当前内容并覆盖 → 重新打开 */
    const doRestoreBackup = useCallback(async () => {
      const name = pendingRestore;
      if (!name || restoring) return;
      setRestoring(true);
      try {
        edit.discardUnsaved(); // 未保存编辑被覆盖（确认框已提示），回到磁盘状态
        setSelection(null);
        await invoke<FileMeta>('restore_backup', {
          tabId,
          path,
          backupName: name,
          backupCount: config.backupEnabled ? config.backupCount : 1,
        });
        setPendingRestore(null);
        const meta = await openFile(path); // 重开文件：重置句柄与分片缓存
        setCursorOffset(meta.size > 0 ? 0 : null);
        resetChunks(meta);
        ensureRange(0, config.bytesPerRow * 2 - 1);
        showToast(`已从 ${name} 恢复（恢复前内容已归档一份备份）`);
      } catch (err) {
        showToast(`恢复失败: ${err}`);
        console.error(err);
      } finally {
        setRestoring(false);
      }
    }, [
      pendingRestore,
      restoring,
      edit,
      tabId,
      path,
      config.backupEnabled,
      config.backupCount,
      config.bytesPerRow,
      openFile,
      resetChunks,
      ensureRange,
      showToast,
    ]);

    /** AI 选项卡徽章：当前会话消息数（用户 + AI 回复） */
    const aiCount = useMemo(
      () => aiChat.messages.reduce((n, m) => (m.role === 'system' ? n : n + 1), 0),
      [aiChat.messages],
    );

    // 卸载时中止未完成的 AI 请求（标签页关闭）
    useEffect(() => () => aiAbortRef.current?.abort(), []);

    // ---------- 视图事件 ----------

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

    // 清理计时器
    useEffect(
      () => () => {
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      },
      [],
    );

    // 标签页激活（切换到本标签 / 本标签首次打开文件完成）时聚焦视图容器，
    // 让方向键 / Alt+←→ 光标历史等键盘操作立即可用
    useEffect(() => {
      if (active && fileMeta) hexViewerRef.current?.focus();
    }, [active, fileMeta]);

    // ---------- 状态上报（App 汇总用于工具栏 / 标签栏） ----------

    const status = useMemo<FileTabStatus>(
      () => ({
        name: fileMeta?.name ?? pathTail(path),
        editCount: edit.editCount,
        searching: search.running,
        searchPercent:
          search.progress && search.progress.total > 0
            ? Math.floor((search.progress.searched / search.progress.total) * 100)
            : 0,
        hitCount: search.results.length,
        previewing: ver.previewing,
      }),
      [fileMeta, path, edit.editCount, search.running, search.progress, search.results.length, ver.previewing],
    );

    useEffect(() => {
      onStatusChange(tabId, status);
    }, [tabId, status, onStatusChange]);

    // ---------- 命令通道（App 转发的全局动作） ----------

    useImperativeHandle(ref, () => ({
      focus: () => hexViewerRef.current?.focus(),
      runSearch: (mode, pattern, caseSensitive) => {
        // 空内容不发搜索，也不切换选项卡
        if (!pattern.trim()) return;
        setActiveSidebarTab('search');
        void search.runSearch(mode, pattern, caseSensitive).then(results => {
          // 搜索完成即定位首个命中（驱动主视图高亮与"替换"目标）
          setActiveHitOffset(results.length > 0 ? results[0].offset : null);
        });
      },
      cancelSearch: () => search.cancelSearch(),
      clearSearch: () => search.clearSearch(),
      goto: text => {
        if (!fileMeta) return;
        const parsed = parseOffsetInput(text);
        if (parsed === null) {
          showToast('无效的偏移（支持 0x 前缀 Hex 或十进制）');
          return;
        }
        if (parsed >= displaySize) {
          showToast('偏移超出文件末尾');
          return;
        }
        jumpToOffset(parsed);
      },
      save: doSave,
      saveAs: () => void doSaveAs(),
      saveShortcut: handleSaveShortcut,
      startEdit,
      insert: startInsert,
      deleteSelection: () => void doDeleteRange(),
      cut: () => void doCut(),
      insertFromClipboard: () => void doInsertFromClipboard(),
      listCommands: () => {
        const cmds: CommandDef[] = [];
        if (!fileMeta) return cmds;
        const editable = displaySize > 0 && !fileMeta.is_readonly && !ver.previewing;
        cmds.push(
          { id: 'file.save', label: '保存', category: '文件', shortcut: 'Ctrl+S' },
          { id: 'file.saveAs', label: '另存为', category: '文件', shortcut: 'Ctrl+Shift+S' },
        );
        if (editable) {
          cmds.push(
            { id: 'edit.startEdit', label: '编辑字节', category: '编辑', shortcut: 'Ctrl+E' },
            { id: 'edit.insert', label: '插入字节', category: '编辑', shortcut: 'Insert' },
            { id: 'edit.insertClipboard', label: '插入剪贴板内容', category: '编辑', shortcut: 'Ctrl+Shift+Insert' },
            { id: 'edit.delete', label: '删除选中 / 单字节', category: '编辑', shortcut: 'Delete' },
            { id: 'edit.cut', label: '剪切选中区间', category: '编辑', shortcut: 'Ctrl+X' },
            { id: 'edit.copyHex', label: '复制 Hex', category: '编辑', shortcut: 'Ctrl+C' },
            { id: 'edit.copyText', label: '复制文本', category: '编辑', shortcut: 'Ctrl+Shift+C' },
            { id: 'edit.pasteHex', label: '粘贴 Hex', category: '编辑', shortcut: 'Ctrl+Shift+V' },
            { id: 'edit.pasteText', label: '粘贴文本', category: '编辑' },
            { id: 'edit.fill', label: '填充区间', category: '编辑' },
          );
        }
        if (edit.canUndo) {
          cmds.push({ id: 'edit.undo', label: '撤销', category: '编辑', shortcut: 'Ctrl+Z' });
        }
        if (edit.canRedo) {
          cmds.push({ id: 'edit.redo', label: '恢复', category: '编辑', shortcut: 'Ctrl+Y' });
        }
        cmds.push(
          { id: 'bm.toggle', label: '切换光标处书签', category: '书签', shortcut: 'Ctrl+B' },
          { id: 'bm.mark', label: '把选择设为标记', category: '书签', shortcut: 'Ctrl+Shift+B' },
          { id: 'bm.next', label: '下一个书签 / 标记', category: '书签', shortcut: 'F2' },
          { id: 'bm.prev', label: '上一个书签 / 标记', category: '书签', shortcut: 'Shift+F2' },
          { id: 'tab.info', label: '文件信息', category: '视图' },
          { id: 'tab.bookmarks', label: '书签列表', category: '视图' },
          { id: 'tab.search', label: '搜索与替换', category: '视图' },
          { id: 'tab.edit', label: '编辑面板', category: '视图' },
          { id: 'tab.versions', label: '历史版本', category: '视图' },
          { id: 'tab.ai', label: 'AI 助手', category: '视图' },
          { id: 'tab.analyze', label: '分析（字符串 / 熵图 / 直方图 / 校验和）', category: '视图' },
        );
        return cmds;
      },
      runCommand: (id: string) => {
        switch (id) {
          case 'file.save':
            handleSaveShortcut();
            break;
          case 'file.saveAs':
            void doSaveAs();
            break;
          case 'edit.startEdit':
            startEdit();
            break;
          case 'edit.insert':
            startInsert();
            break;
          case 'edit.insertClipboard':
            void doInsertFromClipboard();
            break;
          case 'edit.delete':
            void doDeleteRange();
            break;
          case 'edit.cut':
            void doCut();
            break;
          case 'edit.copyHex':
            void copySelection('hex');
            break;
          case 'edit.copyText':
            void copySelection('text');
            break;
          case 'edit.pasteHex':
            void pasteFromClipboard('hex');
            break;
          case 'edit.pasteText':
            void pasteFromClipboard('text');
            break;
          case 'edit.fill':
            startFill();
            break;
          case 'edit.undo':
            if (!ver.previewing) edit.undoLast();
            break;
          case 'edit.redo':
            if (!ver.previewing) edit.redoLast();
            break;
          case 'bm.toggle':
            if (cursorOffset !== null && !ver.previewing) toggleBookmarkAtCursor(cursorOffset);
            break;
          case 'bm.mark':
            addMarkFromSelection();
            break;
          case 'bm.next':
            jumpBookmarkRelative(1);
            break;
          case 'bm.prev':
            jumpBookmarkRelative(-1);
            break;
          case 'tab.info':
            setActiveSidebarTab('info');
            break;
          case 'tab.bookmarks':
            setActiveSidebarTab('bookmarks');
            break;
          case 'tab.search':
            setActiveSidebarTab('search');
            break;
          case 'tab.edit':
            setActiveSidebarTab('edit');
            break;
          case 'tab.versions':
            setActiveSidebarTab('versions');
            break;
          case 'tab.ai':
            setActiveSidebarTab('ai');
            break;
          case 'tab.analyze':
            setActiveSidebarTab('analyze');
            break;
        }
      },
      undo: () => {
        if (ver.previewing) return;
        edit.undoLast();
      },
      redo: () => {
        if (ver.previewing) return;
        edit.redoLast();
      },
      copySelection: (mode, encoding) => void copySelection(mode, encoding),
      paste: kind => void pasteFromClipboard(kind),
      toggleBookmarkAtCursor: () => {
        if (ver.previewing) return;
        if (cursorOffset !== null && fileMeta && cursorOffset < displaySize) {
          toggleBookmarkAtCursor(cursorOffset);
        }
      },
      addMarkFromSelection,
      jumpBookmarkRelative,
      replace: args => void doReplace(args),
      replaceNext: args => void doReplaceNext(args),
      replaceAll: args => void doReplaceAll(args),
      discard: () => edit.discardUnsaved(),
      escape: () => {
        // 分层退出：预览 → 行内编辑 → 选择（弹窗已由 App 层拦截，此处不会遇到）
        if (ver.previewing) {
          ver.exitPreview();
          return;
        }
        if (directEditOffset !== null) {
          setDirectEditOffset(null);
          return;
        }
        setSelectionAnchor(null); // 同时取消"从此处开始选择"的待定锚点
        setSelection(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      },
    }));

    return (
      <div className={`tab-pane${active ? ' active' : ''}`}>
        <div className="tab-inner">
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
              {displayMeta ? (
                <HexViewer
                  key={displayMeta.path}
                  ref={hexViewerRef}
                  meta={displayMeta}
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
                  onZoom={onZoom}
                  bookmarks={bm.sorted}
                  edits={displayEdits}
                  editMode={config.editMode}
                  editTarget={directEditOffset}
                  onEditStart={handleEditStart}
                  onEditCommit={handleEditCommit}
                  onEditCancel={handleEditCancel}
                  readOnly={ver.previewing}
                  hitOffsets={hitOffsets}
                  activeHitOffset={activeHitOffset}
                  onContextMenu={openContextMenu}
                  selectionAnchor={selectionAnchor}
                  onSelectionAnchorChange={setSelectionAnchor}
                  onHistoryNav={navigateHistory}
                />
              ) : (
                <div className="hex-viewer hex-viewer-empty">
                  <div className="empty-state">
                    <div className="empty-title">{pathTail(path)}</div>
                    <div>正在打开文件…</div>
                  </div>
                </div>
              )}
            </main>

            <Sidebar
              activeTab={activeSidebarTab}
              onTabChange={setActiveSidebarTab}
              meta={displayMeta}
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
              onEditModeChange={onEditModeChange}
              confirmSave={config.confirmSave}
              onConfirmSaveChange={onConfirmSaveChange}
              backupEnabled={config.backupEnabled}
              onBackupEnabledChange={onBackupEnabledChange}
              backupCount={config.backupCount}
              onBackupCountChange={onBackupCountChange}
              verifySave={config.verifySave}
              onVerifySaveChange={onVerifySaveChange}
              onRestoreBackup={() => setBackupsOpen(true)}
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
              onFill={startFill}
              onPasteHex={() => void pasteFromClipboard('hex')}
              onPasteText={() => void pasteFromClipboard('text')}
              onInsert={startInsert}
              onDeleteRange={() => void doDeleteRange()}
              onCut={() => void doCut()}
              onInsertFromClipboard={() => void doInsertFromClipboard()}
              inspector={
                <DataInspector
                  offset={cursorOffset}
                  fileSize={displaySize}
                  readRange={readDisplayRange}
                  digits={digits}
                />
              }
              versionsPane={
                <SidebarVersions
                  meta={fileMeta}
                  mode={config.versionMode}
                  onModeChange={onVersionModeChange}
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
                  config={aiConfig}
                  onConfigChange={onAiConfigChange}
                  onResetSystemPrompt={onAiResetSystemPrompt}
                  messages={aiChat.messages}
                  generating={aiGenerating}
                  onSend={handleAiSend}
                  onStop={handleAiStop}
                  onClearRequest={() => setAiClearConfirmOpen(true)}
                  onExport={() => setExportOpen(true)}
                  onGenerateTemplate={() => void openTemplateDialog()}
                  digits={digits}
                />
              }
              aiCount={aiCount}
              analyzePane={
                <SidebarAnalyze
                  tabId={tabId}
                  meta={fileMeta}
                  selection={selection}
                  digits={digits}
                  stats={stats.stats}
                  strings={strings}
                  onJumpToString={jumpToString}
                  onJumpToOffset={offset => {
                    setSelection({ start: offset, end: offset });
                    jumpToOffset(offset);
                  }}
                  showToast={showToast}
                />
              }
              perfEnabled={active}
              cacheBytes={cacheBytes}
              visibleRows={visibleRows}
            />
          </div>

          <StatusBar
            meta={displayMeta}
            hoverOffset={hoverOffset}
            cursorOffset={cursorOffset}
            selection={selection}
            rowBytes={config.bytesPerRow}
            encoding={config.encoding}
            loading={loading}
            toast={toast}
            onCopyHex={() => void copySelection('hex')}
            onCopyText={encoding => void copySelection('text', encoding)}
          />
        </div>

        {/* 对话框编辑（Ctrl+E） */}
        {editDialogRange && fileMeta && (
          <EditDialog
            start={editDialogRange.start}
            end={editDialogRange.end}
            digits={digits}
            loadBytes={loadDialogBytes}
            onCommit={commitDialogEdit}
            onCancel={() => setEditDialogRange(null)}
          />
        )}

        {/* 填充选中区间（块选择时按行填充，汇总展示） */}
        {fillRange && fileMeta && (
          <FillDialog
            start={fillRange.start}
            end={fillRange.end}
            digits={digits}
            label={
              fillBlockRanges
                ? `块选择 ${fillBlockRanges.length} 行（${fillBlockRanges.reduce((n, [s, e]) => n + (e - s + 1), 0)} 字节）`
                : undefined
            }
            totalBytes={
              fillBlockRanges
                ? fillBlockRanges.reduce((n, [s, e]) => n + (e - s + 1), 0)
                : undefined
            }
            onCommit={v => void commitFill(v)}
            onCancel={() => {
              setFillRange(null);
              setFillBlockRanges(null);
            }}
          />
        )}

        {/* 插入字节（Insert 键 / 侧栏按钮） */}
        {insertAt !== null && fileMeta && (
          <InsertDialog
            offset={insertAt}
            digits={digits}
            encoding={config.encoding}
            onCommit={commitInsert}
            onCancel={() => setInsertAt(null)}
          />
        )}

        {/* 崩溃恢复：检测到未保存编辑的自动保存 */}
        {autosavePrompt && fileMeta && (
          <ConfirmDialog
            title="检测到未保存的编辑"
            message={`${fileMeta.name} 在 ${new Date(autosavePrompt.time).toLocaleString('zh-CN', { hour12: false })} 有未保存编辑（上次可能异常退出），是否恢复？`}
            buttons={[
              {
                label: '恢复',
                kind: 'primary',
                onClick: () => {
                  const info = autosavePrompt;
                  setAutosavePrompt(null);
                  edit.restoreSnapshot(info.payload);
                  if (info.payload.cursor !== null) setCursorOffset(info.payload.cursor);
                  if (info.payload.selection) setSelection(info.payload.selection);
                  showToast('已恢复未保存的编辑（可 Ctrl+Z 撤销）');
                },
              },
              {
                label: '丢弃',
                kind: 'danger',
                onClick: () => {
                  setAutosavePrompt(null);
                  invoke('clear_autosave', { filePath: fileMeta.path }).catch(() => {});
                  showToast('已丢弃未保存的编辑');
                },
              },
              {
                label: '稍后',
                kind: 'plain',
                onClick: () => setAutosavePrompt(null),
              },
            ]}
            onCancel={() => setAutosavePrompt(null)}
          />
        )}

        {/* 主视图右键菜单 */}
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            entries={ctxEntries}
            onClose={() => setCtxMenu(null)}
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

        {/* 导出 AI 会话（v1.1.5） */}
        {exportOpen && displayMeta && (
          <ExportChatDialog
            meta={displayMeta}
            messages={aiChat.messages}
            onClose={() => setExportOpen(false)}
            onToast={showToast}
          />
        )}

        {/* AI 生成模板（v1.1.5） */}
        {templateInput && (
          <AiTemplateDialog
            input={templateInput}
            aiConfig={aiConfig}
            templates={tpl.templates}
            onSaveTemplate={(name, fields) => tpl.saveTemplate(name, fields)}
            onDeleteTemplate={tpl.deleteTemplate}
            onApply={applyTemplateFields}
            onRecord={recordTemplateExchange}
            onClose={() => setTemplateInput(null)}
            onToast={showToast}
          />
        )}

        {/* 从备份恢复：备份列表（v1.1.5） */}
        {backupsOpen && fileMeta && (
          <BackupRestoreDialog
            meta={fileMeta}
            onClose={() => setBackupsOpen(false)}
            onRestore={handlePickBackup}
            onToast={showToast}
          />
        )}

        {/* 从备份恢复：覆盖确认 */}
        {pendingRestore && fileMeta && (
          <ConfirmDialog
            title="从备份恢复"
            message={`将用备份「${pendingRestore}」覆盖当前文件，当前未保存的编辑会被丢弃；恢复前当前内容会先归档一份备份。是否继续？`}
            buttons={[
              {
                label: restoring ? '恢复中…' : '恢复',
                kind: 'primary',
                onClick: () => void doRestoreBackup(),
              },
              {
                label: '取消',
                kind: 'plain',
                onClick: () => setPendingRestore(null),
              },
            ]}
            onCancel={() => setPendingRestore(null)}
          />
        )}
      </div>
    );
  }),
);
