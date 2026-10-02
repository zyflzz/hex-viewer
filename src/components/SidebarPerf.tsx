import type { PerfState } from '../hooks/usePerfMonitor';
import { formatNumber } from '../utils/format';

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

interface SidebarPerfProps {
  perf: PerfState;
  cacheBytes: number;
  visibleRows: number;
  totalRows: number;
  /** 未保存编辑字节数 */
  editCount: number;
}

/** 性能监控：固定在侧栏底部，所有选项卡共享 */
export function SidebarPerf({ perf, cacheBytes, visibleRows, totalRows, editCount }: SidebarPerfProps) {
  return (
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
      <div className="perf-row plain">
        <span className="perf-label">未保存修改</span>
        <span className={`perf-value${editCount > 0 ? ' warn' : ''}`}>
          {editCount > 0 ? `${formatNumber(editCount)} 字节` : '无修改'}
        </span>
      </div>
    </div>
  );
}
