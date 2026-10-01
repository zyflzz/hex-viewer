import type { FileMeta } from '../types';
import type { SearchState } from '../hooks/useFileSearch';
import { byteToAscii, formatNumber, hexByte, hexOffset, offsetDigits } from '../utils/format';

interface SidebarSearchProps {
  meta: FileMeta | null;
  search: SearchState;
  activeHitOffset: number | null;
  onJumpToOffset: (offset: number) => void;
}

/** "搜索"选项卡：搜索进度与结果列表 */
export function SidebarSearch({ meta, search, activeHitOffset, onJumpToOffset }: SidebarSearchProps) {
  const digits = meta ? offsetDigits(meta.size) : 8;
  const percent =
    search.progress && search.progress.total > 0
      ? Math.floor((search.progress.searched / search.progress.total) * 100)
      : 0;

  return (
    <section className="side-section side-search">
      <h3>
        搜索结果
        {!search.running && search.results.length > 0 && (
          <span className="side-progress-text">
            {formatNumber(search.results.length)} 处{search.truncated ? '+' : ''}
          </span>
        )}
        {search.running && <span className="side-progress-text">{percent}%</span>}
      </h3>
      {search.running && (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {search.error && <p className="side-error">{search.error}</p>}
      {!search.running && !search.error && search.results.length === 0 && (
        <p className="placeholder-text">在工具栏输入关键词后按 Enter 搜索</p>
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
  );
}
