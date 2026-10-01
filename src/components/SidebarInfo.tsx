import type { FileMeta, FileStats } from '../types';
import type { StatsState } from '../hooks/useFileStats';
import { formatBytes, formatDateTime, formatNumber } from '../utils/format';

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

interface SidebarInfoProps {
  meta: FileMeta | null;
  stats: StatsState;
  totalRows: number;
}

/** "信息"选项卡：文件信息 + 内容统计 */
export function SidebarInfo({ meta, stats, totalRows }: SidebarInfoProps) {
  return (
    <>
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
    </>
  );
}
