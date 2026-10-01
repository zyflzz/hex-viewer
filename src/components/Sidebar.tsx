import React, { useState } from 'react';
import type { Bookmark, FileMeta, FileStats } from '../types';
import type { StatsState } from '../hooks/useFileStats';
import type { SearchState } from '../hooks/useFileSearch';
import type { PerfState } from '../hooks/usePerfMonitor';
import { MARKER_COLORS } from '../hooks/useFileBookmarks';
import {
  byteToAscii,
  formatBytes,
  formatDateTime,
  formatNumber,
  hexByte,
  hexOffset,
  offsetDigits,
} from '../utils/format';

/** 迷你趋势图（SVG 折线） */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 100;
  const h = 24;
  if (data.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${w} ${h}`} />;
  }
  const hi = Math.max(...data, 0.001);
  const pts = data
    .map(
      (v, i) =>
        `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - (Math.min(v, hi) / hi) * (h - 2)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function InfoItem({ label, value, mono, title }: { label: string; value: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="info-item" title={title}>
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

/** 统计分布条：可打印 / 换行 / 控制 / 高位 / 零字节 */
function DistBar({ stats }: { stats: FileStats }) {
  const total = Math.max(stats.total, 1);
  const segs: Array<[string, number, string]> = [
    ['printable', stats.printable, '可打印'],
    ['lb', stats.line_breaks, '换行'],
    ['ctrl', stats.control, '控制'],
    ['high', stats.high, '高位'],
    ['zero', stats.zero, '零字节'],
  ];
  return (
    <div className="dist-bar" title={segs.map(s => `${s[2]} ${formatNumber(s[1])}`).join(' / ')}>
      {segs.map(([cls, n]) => (
        <div key={cls} className={`dist-seg ${cls}`} style={{ width: `${(n / total) * 100}%` }} />
      ))}
    </div>
  );
}

interface SidebarProps {
  meta: FileMeta | null;
  stats: StatsState;
  search: SearchState;
  perf: PerfState;
  cacheBytes: number;
  visibleRows: number;
  totalRows: number;
  activeHitOffset: number | null;
  onJumpToOffset: (offset: number) => void;
  // 书签与标记
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

export function Sidebar({
  meta,
  stats,
  search,
  perf,
  cacheBytes,
  visibleRows,
  totalRows,
  activeHitOffset,
  onJumpToOffset,
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
}: SidebarProps) {
  const searchPercent =
    search.progress && search.progress.total > 0
      ? Math.floor((search.progress.searched / search.progress.total) * 100)
      : 0;
  const digits = meta ? offsetDigits(meta.size) : 8;
  const hasFile = !!meta && meta.size > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <section className="side-section">
          <h3>文件信息</h3>
          {meta ? (
            <div className="info-list">
              <InfoItem label="名称" value={meta.name} title={meta.path} />
              <InfoItem label="类型" value={meta.kind} />
              <InfoItem label="大小" value={`${formatBytes(meta.size)} (${formatNumber(meta.size)} B)`} />
              <InfoItem label="总行数" value={totalRows > 0 ? formatNumber(totalRows) : '-'} />
              <InfoItem label="扩展名" value={meta.extension ? `.${meta.extension}` : '-'} />
              <InfoItem label="修改时间" value={formatDateTime(meta.modified)} />
              <InfoItem label="创建时间" value={formatDateTime(meta.created)} />
              <InfoItem label="只读" value={meta.is_readonly ? '是' : '否'} />
              <InfoItem label="路径" value={<code>{meta.path}</code>} title={meta.path} />
            </div>
          ) : (
            <p className="placeholder-text">暂无文件信息</p>
          )}
        </section>

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
            <p className="placeholder-text">光标处按 Ctrl+B 添加书签</p>
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

        <section className="side-section">
          <h3>
            内容统计
            {stats.running && (
              <span className="side-progress-text">
                {Math.floor(stats.progress * 100)}%
              </span>
            )}
          </h3>
          {meta && stats.running && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${stats.progress * 100}%` }} />
            </div>
          )}
          {meta && stats.stats ? (
            <div className="info-list">
              <DistBar stats={stats.stats} />
              <InfoItem label="可打印字符" value={formatNumber(stats.stats.printable)} />
              <InfoItem label="换行符" value={formatNumber(stats.stats.line_breaks)} />
              <InfoItem label="控制字符" value={formatNumber(stats.stats.control)} />
              <InfoItem label="高位字节" value={formatNumber(stats.stats.high)} />
              <InfoItem label="零字节" value={formatNumber(stats.stats.zero)} />
            </div>
          ) : meta && !stats.running ? (
            <p className="placeholder-text">统计不可用</p>
          ) : (
            <p className="placeholder-text">打开文件后自动统计</p>
          )}
        </section>

        <section className="side-section side-search">
          <h3>
            搜索结果
            {search.results.length > 0 && (
              <span className="side-progress-text">
                {formatNumber(search.results.length)} 处{search.truncated ? '+' : ''}
              </span>
            )}
          </h3>
          {search.running && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${searchPercent}%` }} />
            </div>
          )}
          {search.error && <p className="side-error">{search.error}</p>}
          {!search.running && !search.error && search.results.length === 0 && meta && (
            <p className="placeholder-text">无匹配（Enter 或点击"搜索"开始）</p>
          )}
          {search.results.length > 0 && (
            <ul className="hit-list">
              {search.results.slice(0, 500).map(hit => (
                <li
                  key={hit.offset}
                  className={`hit-item${hit.offset === activeHitOffset ? ' active' : ''}`}
                  onClick={() => onJumpToOffset(hit.offset)}
                >
                  <span className="hit-offset">{hexOffset(hit.offset, digits)}</span>
                  <span className="hit-preview">
                    {hit.context.slice(0, 8).map(b => hexByte(b)).join(' ')}
                  </span>
                  <span className="hit-ascii">
                    {hit.context.slice(0, 16).map(b => byteToAscii(b)).join('')}
                  </span>
                </li>
              ))}
              {search.results.length > 500 && (
                <li className="hit-more">仅显示前 500 条，共 {formatNumber(search.results.length)} 处</li>
              )}
            </ul>
          )}
        </section>
      </div>

      <div className="sidebar-perf">
        <h3>性能监控</h3>
        <div className="perf-row">
          <span className="perf-label">内存</span>
          <span className="perf-value">
            {perf.current ? `${(perf.current.memory / 1024 / 1024).toFixed(1)} MB` : '-'}
          </span>
          <Sparkline data={perf.memoryHistory} color="var(--perf-mem)" />
        </div>
        <div className="perf-row">
          <span className="perf-label">CPU</span>
          <span className="perf-value">
            {perf.current ? `${perf.current.cpu.toFixed(1)}%` : '-'}
          </span>
          <Sparkline data={perf.cpuHistory} color="var(--perf-cpu)" />
        </div>
        <div className="perf-row plain">
          <span className="perf-label">数据缓存</span>
          <span className="perf-value">{(cacheBytes / 1024).toFixed(0)} KB</span>
        </div>
        <div className="perf-row plain">
          <span className="perf-label">渲染行数</span>
          <span className="perf-value">{visibleRows} / {totalRows ? formatNumber(totalRows) : '-'}</span>
        </div>
      </div>
    </aside>
  );
}
