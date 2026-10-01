import { useState } from 'react';
import type { Bookmark, FileMeta } from '../types';
import { MARKER_COLORS } from '../hooks/useFileBookmarks';
import { formatNumber, hexOffset, offsetDigits } from '../utils/format';

/** 单条书签/标记：色块（可改色）、偏移、内联命名、删除 */
function BookmarkItem({
  bm,
  active,
  invalid,
  digits,
  onUpdate,
  onRemove,
  onJump,
}: {
  bm: Bookmark;
  active: boolean;
  invalid: boolean;
  digits: number;
  onUpdate: (id: string, patch: Partial<Omit<Bookmark, 'id'>>) => void;
  onRemove: (id: string) => void;
  onJump: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bm.name);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const commit = () => {
    onUpdate(bm.id, { name: draft.trim() });
    setEditing(false);
  };

  const rangeText =
    bm.start === bm.end
      ? hexOffset(bm.start, digits)
      : `${hexOffset(bm.start, digits)}–${hexOffset(bm.end, digits)}`;

  return (
    <li className={`bm-item${active ? ' active' : ''}${invalid ? ' invalid' : ''}`}>
      {paletteOpen ? (
        <span className="bm-palette">
          {MARKER_COLORS.map(c => (
            <button
              key={c}
              className={`bm-swatch${c === bm.color ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => {
                onUpdate(bm.id, { color: c });
                setPaletteOpen(false);
              }}
            />
          ))}
        </span>
      ) : (
        <button
          className="bm-color"
          style={{ background: bm.color }}
          title="更改颜色"
          onClick={() => setPaletteOpen(true)}
        />
      )}
      <span className="bm-range mono" onClick={onJump}>
        {rangeText}
      </span>
      {editing ? (
        <input
          className="bm-name-input"
          value={draft}
          autoFocus
          placeholder="未命名"
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setDraft(bm.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="bm-name"
          title={bm.name || undefined}
          onClick={() => {
            setDraft(bm.name);
            setEditing(true);
          }}
        >
          {bm.name || '未命名'}
        </span>
      )}
      <button className="bm-del" title="删除" onClick={() => onRemove(bm.id)}>
        ×
      </button>
    </li>
  );
}

interface SidebarBookmarksProps {
  meta: FileMeta | null;
  bookmarks: Bookmark[];
  activeBookmarkId: string | null;
  cursorOffset: number | null;
  hasSelection: boolean;
  maxBookmarkItems: number;
  onToggleBookmark: (offset: number) => void;
  /** 把当前选择区间转成标记（选择区间由 App 层读取） */
  onAddMark: () => void;
  onJumpToBookmark: (bm: Bookmark) => void;
  onRemoveBookmark: (id: string) => void;
  onUpdateBookmark: (id: string, patch: Partial<Omit<Bookmark, 'id'>>) => void;
  onClearBookmarks: () => void;
}

/** "书签"选项卡：书签与标记列表（点/区间混排，按偏移排序） */
export function SidebarBookmarks({
  meta,
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
}: SidebarBookmarksProps) {
  const digits = meta ? offsetDigits(meta.size) : 8;
  const hasFile = !!meta && meta.size > 0;

  return (
    <section className="side-section">
      <h3>
        书签与标记
        {bookmarks.length > 0 && (
          <span className="side-progress-text">{formatNumber(bookmarks.length)}</span>
        )}
      </h3>
      {hasFile && (
        <div className="bm-actions">
          <button
            className="btn mini"
            disabled={cursorOffset === null}
            title="在光标处添加/删除书签（Ctrl+B）"
            onClick={() => cursorOffset !== null && onToggleBookmark(cursorOffset)}
          >
            书签
          </button>
          <button
            className="btn mini"
            disabled={!hasSelection}
            title="把当前选择转成标记（Ctrl+Shift+B）"
            onClick={onAddMark}
          >
            标记
          </button>
          <button
            className="btn mini danger"
            disabled={bookmarks.length === 0}
            title="清空当前文件的全部书签与标记"
            onClick={onClearBookmarks}
          >
            清空
          </button>
        </div>
      )}
      {!hasFile ? (
        <p className="placeholder-text">打开文件后可用</p>
      ) : bookmarks.length === 0 ? (
        <p className="placeholder-text">
          光标处按 Ctrl+B 添加书签
          <br />
          选中区间后按 Ctrl+Shift+B 添加标记
        </p>
      ) : (
        <ul className="bm-list">
          {bookmarks.slice(0, maxBookmarkItems).map(bm => (
            <BookmarkItem
              key={bm.id}
              bm={bm}
              active={bm.id === activeBookmarkId}
              invalid={bm.start >= (meta?.size ?? 0)}
              digits={digits}
              onUpdate={onUpdateBookmark}
              onRemove={onRemoveBookmark}
              onJump={() => onJumpToBookmark(bm)}
            />
          ))}
          {bookmarks.length > maxBookmarkItems && (
            <li className="bm-more">
              仅显示前 {maxBookmarkItems} 条，共 {formatNumber(bookmarks.length)} 条
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
