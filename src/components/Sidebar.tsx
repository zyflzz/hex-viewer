import type { Bookmark, EditMode, FileMeta, SidebarTab } from '../types';
import type { StatsState } from '../hooks/useFileStats';
import type { SearchState } from '../hooks/useFileSearch';
import type { PerfState } from '../hooks/usePerfMonitor';
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
  // 性能（公共底部）
  perf: PerfState;
  cacheBytes: number;
  visibleRows: number;
}

/** 侧栏容器：顶部选项卡栏 + 四个常驻 pane（display 切换保留状态）+ 底部性能监控 */
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
    perf,
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
      </div>

      <div className="sidebar-body">
        <div className="sidebar-pane" style={{ display: activeTab === 'info' ? 'block' : 'none' }}>
          <SidebarInfo meta={meta} stats={stats} totalRows={totalRows} />
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
          />
        </div>
      </div>

      <SidebarPerf
        perf={perf}
        cacheBytes={cacheBytes}
        visibleRows={visibleRows}
        totalRows={totalRows}
        editCount={editCount}
      />
    </aside>
  );
}
