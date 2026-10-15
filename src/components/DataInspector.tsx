import { useEffect, useMemo, useRef, useState } from 'react';
import { inspectBytes, type InspectRow } from '../utils/inspect';
import { hexOffset, offsetDigits } from '../utils/format';

const INSPECT_BYTES = 16;
const DEBOUNCE_MS = 50;

interface DataInspectorProps {
  /** 光标偏移；无文件 / 空文件为 null */
  offset: number | null;
  fileSize: number;
  /** 读取显示内容（含编辑覆盖层），与主视图一致 */
  readRange: (offset: number, len: number) => Promise<Uint8Array>;
  /** 偏移显示位数 */
  digits: number;
}

interface Loaded {
  offset: number;
  bytes: Uint8Array;
}

function RowView({ row, onCopy }: { row: InspectRow; onCopy: (v: string) => void }) {
  return (
    <div className={`insp-row${row.ok ? '' : ' dim'}`}>
      <span className="insp-label" title={row.label}>
        {row.label}
      </span>
      <span className="insp-value mono" title={row.value}>
        {row.swatch && <span className="insp-swatch" style={{ background: row.swatch }} />}
        {row.value}
      </span>
      <button
        className="insp-copy"
        title="复制"
        disabled={row.value === '—'}
        onClick={() => onCopy(row.value)}
      >
        ⧉
      </button>
    </div>
  );
}

/**
 * 数据检查器（只读）：跟随光标读取 16 字节做多视角解读。
 * 光标变化时防抖 50ms；读取期间保留上一份数据并整体置灰。
 */
export function DataInspector({ offset, fileSize, readRange, digits }: DataInspectorProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [stale, setStale] = useState(false);
  const timerRef = useRef<number | null>(null);
  const digitsSafe = digits || offsetDigits(fileSize);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (offset === null || fileSize === 0) {
      setLoaded(null);
      setStale(false);
      return;
    }
    // 先标记旧数据过期（置灰），防抖后再读取新数据
    setStale(true);
    const target = offset;
    timerRef.current = window.setTimeout(() => {
      const len = Math.min(INSPECT_BYTES, fileSize - target);
      readRange(target, len)
        .then(bytes => {
          setLoaded({ offset: target, bytes });
          setStale(false);
        })
        .catch(() => {
          /* 读取失败保留旧数据（仍置灰） */
        });
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [offset, fileSize, readRange]);

  const sections = useMemo(
    () => (loaded ? inspectBytes(loaded.bytes) : []),
    [loaded],
  );

  const copyValue = (v: string) => {
    navigator.clipboard.writeText(v).catch(() => {});
  };

  return (
    <section className="side-section">
      <h3>
        数据检查器
        {loaded && (
          <span className="side-progress-text mono">
            @ {hexOffset(loaded.offset, digitsSafe)}
          </span>
        )}
      </h3>
      {loaded ? (
        <div className={`insp-body${stale ? ' stale' : ''}`}>
          {sections.map(sec => (
            <div key={sec.title} className="insp-group">
              <div className="insp-group-title">{sec.title}</div>
              {sec.rows.map(row => (
                <RowView key={row.label} row={row} onCopy={copyValue} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="placeholder-text">
          {offset === null ? '点击字节定位光标后显示解读' : '光标处无数据'}
        </p>
      )}
    </section>
  );
}
