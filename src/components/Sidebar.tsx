import React from 'react';
import type { FileMeta, FileStats } from '../types';
import type { StatsState } from '../hooks/useFileStats';
import type { SearchState } from '../hooks/useFileSearch';
import type { PerfState } from '../hooks/usePerfMonitor';
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
}: SidebarProps) {
  const searchPercent =
    search.progress && search.progress.total > 0
      ? Math.floor((search.progress.searched / search.progress.total) * 100)
      : 0;
  const digits = meta ? offsetDigits(meta.size) : 8;

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
