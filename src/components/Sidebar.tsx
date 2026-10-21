import type { ReactNode } from 'react';
import type { Bookmark, EditMode, FileMeta, SidebarTab } from '../types';
import type { StatsState } from '../hooks/useFileStats';
import type { SearchState } from '../hooks/useFileSearch';
import type { EditOp } from '../hooks/useFileEdits';
import { SidebarInfo } from './SidebarInfo';
import { SidebarBookmarks } from './SidebarBookmarks';
import { SidebarSearch } from './SidebarSearch';
import { SidebarEdit } from './SidebarEdit';
import { SidebarPerf } from './SidebarPerf';

interface SidebarProps {
  // 选项卡
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  // 信息
  meta: FileMeta | null;
  stats: StatsState;
  totalRows: number;
  // 书签
  bookmarks: Bookmark[];
  activeBookmarkId: string | null;
  cursorOffset: number | null;
  hasSelection: boolean;
  maxBookmarkItems: number;
  onToggleBookmark: (offset: number) => void;
  onAddMark: () => void;
  onJumpToBookmark: (bm: Bookmark) => void;
  onRemoveBookmark: (id: string) => void;
  onUpdateBookmark: (id: string, patch: Partial<Omit<Bookmark, 'id'>>) => void;
  onClearBookmarks: () => void;
  // 搜索
  search: SearchState;
  activeHitOffset: number | null;
  onJumpToOffset: (offset: number) => void;
  // 编辑
  editMode: EditMode;
  onEditModeChange: (m: EditMode) => void;
  confirmSave: boolean;
  onConfirmSaveChange: (v: boolean) => void;
  /** 数据安全（v1.1.5）：自动备份 / 保存后校验 */
  backupEnabled: boolean;
  onBackupEnabledChange: (v: boolean) => void;
  backupCount: number;
  onBackupCountChange: (n: 1 | 2 | 3 | 5 | 10) => void;
  verifySave: boolean;
  onVerifySaveChange: (v: boolean) => void;
  /** 打开"从备份恢复"对话框 */
  onRestoreBackup: () => void;
  editCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onUndoTo: (index: number) => void;
  onRedoTo: (index: number) => void;
  ops: EditOp[];
  pos: number;
  onEditSelection: () => void;
  onDiscardAll: () => void;
  /** 填充选中区间（无选中时 App 层提示） */
  onFill: () => void;
  /** 从光标/选择起点粘贴 Hex */
  onPasteHex: () => void;
  /** 按当前显示编码粘贴文本 */
  onPasteText: () => void;
  /** 在光标/选择起点前插入字节（弹对话框） */
  onInsert: () => void;
  /** 删除选中区间 / 光标处单字节 */
  onDeleteRange: () => void;
  /** 剪切选中区间（复制 + 删除） */
  onCut: () => void;
  /** 把剪贴板内容插入到光标处 */
  onInsertFromClipboard: () => void;
  /** 数据检查器（渲染在"信息"选项卡底部，自带节结构） */
  inspector?: ReactNode;
  /** 历史版本选项卡内容（独立于编辑选项卡） */
  versionsPane?: ReactNode;
  /** 历史版本数（标签徽章） */
  versionsCount: number;
  /** 预览历史版本中：编辑选项卡锁定为只读 */
  previewActive: boolean;
  /** AI 助手选项卡内容（自带配置/对话/输入布局，无需滚动容器） */
  aiPane?: ReactNode;
  /** 当前会话消息数（AI 标签徽章，用户 + AI 回复） */
  aiCount: number;
  /** 分析选项卡内容（字符串提取 + 校验和） */
  analyzePane?: ReactNode;
  /** 是否渲染性能监控（仅激活标签页订阅全局采样，隐藏标签页跳过 1Hz 重渲染） */
  perfEnabled: boolean;
  cacheBytes: number;
  visibleRows: number;
}

/** 侧栏容器：顶部选项卡栏 + 六个常驻 pane（display 切换保留状态）+ 底部性能监控 */
export function Sidebar(props: SidebarProps) {
  const {
    activeTab,
    onTabChange,
    meta,
    stats,
    totalRows,
    bookmarks,
    activeBookmarkId,
    cursorOffset,
    hasSelection,
    maxBookmarkItems,
    onToggleBookmark,
    onAddMark,
    onJumpToBookmark,
    onRemoveBookmark,
    onUpdateBookmark,
    onClearBookmarks,
    search,
    activeHitOffset,
    onJumpToOffset,
    editMode,
    onEditModeChange,
    confirmSave,
    onConfirmSaveChange,
    backupEnabled,
    onBackupEnabledChange,
    backupCount,
    onBackupCountChange,
    verifySave,
    onVerifySaveChange,
    onRestoreBackup,
    editCount,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onUndoTo,
    onRedoTo,
    ops,
    pos,
    onEditSelection,
    onDiscardAll,
    onFill,
    onPasteHex,
    onPasteText,
    onInsert,
    onDeleteRange,
    onCut,
    onInsertFromClipboard,
    inspector,
    versionsPane,
    versionsCount,
    previewActive,
    aiPane,
    aiCount,
    analyzePane,
    perfEnabled,
    cacheBytes,
    visibleRows,
  } = props;

  // 搜索徽章：进行中显示百分比，完成显示命中数（>99 显示 99+）
  const searchBadge = search.running
    ? search.progress && search.progress.total > 0
      ? `${Math.floor((search.progress.searched / search.progress.total) * 100)}%`
      : null
    : search.results.length > 0
      ? search.results.length > 99
        ? '99+'
        : String(search.results.length)
      : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs" role="tablist">
        <button
          className={`sidebar-tab${activeTab === 'info' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'info'}
          onClick={() => onTabChange('info')}
        >
          信息
        </button>
        <button
          className={`sidebar-tab${activeTab === 'bookmarks' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'bookmarks'}
          onClick={() => onTabChange('bookmarks')}
        >
          书签
          {bookmarks.length > 0 && (
            <span className="tab-badge">{bookmarks.length > 99 ? '99+' : bookmarks.length}</span>
          )}
        </button>
        <button
          className={`sidebar-tab${activeTab === 'search' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'search'}
          onClick={() => onTabChange('search')}
        >
          搜索
          {searchBadge && <span className="tab-badge">{searchBadge}</span>}
        </button>
        <button
          className={`sidebar-tab${activeTab === 'edit' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'edit'}
          onClick={() => onTabChange('edit')}
        >
          编辑
          {editCount > 0 && (
            <span className="tab-badge">{editCount > 99 ? '99+' : editCount}</span>
          )}
        </button>
        <button
          className={`sidebar-tab${activeTab === 'versions' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'versions'}
          onClick={() => onTabChange('versions')}
        >
          版本
          {versionsCount > 0 && (
            <span className="tab-badge">{versionsCount > 99 ? '99+' : versionsCount}</span>
          )}
        </button>
        <button
          className={`sidebar-tab${activeTab === 'ai' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'ai'}
          onClick={() => onTabChange('ai')}
        >
          AI
          {aiCount > 0 && <span className="tab-badge">{aiCount > 99 ? '99+' : aiCount}</span>}
        </button>
        <button
          className={`sidebar-tab${activeTab === 'analyze' ? ' on' : ''}`}
          role="tab"
          aria-selected={activeTab === 'analyze'}
          onClick={() => onTabChange('analyze')}
        >
          分析
        </button>
      </div>

      <div className="sidebar-body">
        <div className="sidebar-pane" style={{ display: activeTab === 'info' ? 'block' : 'none' }}>
          <SidebarInfo meta={meta} stats={stats} totalRows={totalRows} />
          {inspector}
        </div>
        <div className="sidebar-pane" style={{ display: activeTab === 'bookmarks' ? 'block' : 'none' }}>
          <SidebarBookmarks
            meta={meta}
            bookmarks={bookmarks}
            activeBookmarkId={activeBookmarkId}
            cursorOffset={cursorOffset}
            hasSelection={hasSelection}
            maxBookmarkItems={maxBookmarkItems}
            onToggleBookmark={onToggleBookmark}
            onAddMark={onAddMark}
            onJumpToBookmark={onJumpToBookmark}
            onRemoveBookmark={onRemoveBookmark}
            onUpdateBookmark={onUpdateBookmark}
            onClearBookmarks={onClearBookmarks}
            readOnly={previewActive}
          />
        </div>
        <div className="sidebar-pane" style={{ display: activeTab === 'search' ? 'block' : 'none' }}>
          <SidebarSearch meta={meta} search={search} activeHitOffset={activeHitOffset} onJumpToOffset={onJumpToOffset} />
        </div>
        <div className="sidebar-pane" style={{ display: activeTab === 'edit' ? 'block' : 'none' }}>
          <SidebarEdit
            meta={meta}
            editMode={editMode}
            onEditModeChange={onEditModeChange}
            confirmSave={confirmSave}
            onConfirmSaveChange={onConfirmSaveChange}
            backupEnabled={backupEnabled}
            onBackupEnabledChange={onBackupEnabledChange}
            backupCount={backupCount}
            onBackupCountChange={onBackupCountChange}
            verifySave={verifySave}
            onVerifySaveChange={onVerifySaveChange}
            onRestoreBackup={onRestoreBackup}
            editCount={editCount}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
            onUndoTo={onUndoTo}
            onRedoTo={onRedoTo}
            ops={ops}
            pos={pos}
            onEditSelection={onEditSelection}
            onDiscardAll={onDiscardAll}
            onFill={onFill}
            onPasteHex={onPasteHex}
            onPasteText={onPasteText}
            onInsert={onInsert}
            onDeleteRange={onDeleteRange}
            onCut={onCut}
            onInsertFromClipboard={onInsertFromClipboard}
            hasSelection={hasSelection}
            locked={previewActive}
          />
        </div>
        <div
          className="sidebar-pane"
          style={{ display: activeTab === 'versions' ? 'block' : 'none' }}
        >
          {versionsPane}
        </div>
        {/* AI 面板自带内部滚动（对话区），外层不滚动：display 用 flex 撑满 */}
        <div
          className="sidebar-pane ai-pane"
          style={{ display: activeTab === 'ai' ? 'flex' : 'none' }}
        >
          {aiPane}
        </div>
        {/* 分析面板自带内部滚动（字符串区），外层 pane 不滚动：校验和固定在底部 */}
        <div
          className="sidebar-pane analyze-pane"
          style={{ display: activeTab === 'analyze' ? 'flex' : 'none' }}
        >
          {analyzePane}
        </div>
      </div>

      {perfEnabled && (
        <SidebarPerf
          cacheBytes={cacheBytes}
          visibleRows={visibleRows}
          totalRows={totalRows}
          editCount={editCount}
        />
      )}
    </aside>
  );
}
