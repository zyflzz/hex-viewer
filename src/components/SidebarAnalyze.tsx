import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Checksums, FileMeta, FileStats, Selection, StringEncoding, StringHit } from '../types';
import { hexOffset } from '../utils/format';
import type { StringExtractState } from '../hooks/useStringExtract';

/** 校验和单行定义 */
const CK_ROWS: Array<{ key: keyof Checksums; name: string }> = [
  { key: 'crc32', name: 'CRC32' },
  { key: 'crc16', name: 'CRC16-CCITT' },
  { key: 'adler32', name: 'Adler32' },
  { key: 'md5', name: 'MD5' },
  { key: 'sha1', name: 'SHA-1' },
  { key: 'sha256', name: 'SHA-256' },
  { key: 'xor8', name: 'XOR8' },
  { key: 'sum8', name: 'Sum8' },
];

/** 校验和上限（与 Rust 侧 MAX_CHECKSUM_LEN 一致） */
const MAX_CK_LEN = 4 * 1024 * 1024;
/** 同区间结果缓存上限（简易 LRU：超限删除最早插入的键） */
const CK_CACHE_MAX = 64;
/** 值超过该长度视为长哈希（MD5/SHA-1/SHA-256），点击弹出完整内容 */
const CK_DETAIL_THRESHOLD = 16;

const ENC_LABELS: Record<StringEncoding, string> = {
  ascii: 'ASCII',
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

interface SidebarAnalyzeProps {
  tabId: string;
  meta: FileMeta | null;
  selection: Selection | null;
  digits: number;
  /** 全文件统计（含直方图 histogram；磁盘内容基准） */
  stats: FileStats | null;
  /** 字符串提取状态（FileTab 层持有） */
  strings: StringExtractState;
  /** 点击字符串：跳转并选中整个字符串 */
  onJumpToString: (hit: StringHit) => void;
  /** 熵图 / 直方图点击：跳转并选中单字节 */
  onJumpToOffset: (offset: number) => void;
  showToast: (msg: string) => void;
}

/** 分析选项卡：熵图 + 字节分布直方图 + 字符串提取（可滚动）+ 校验和（固定底部） */
export function SidebarAnalyze({
  tabId,
  meta,
  selection,
  digits,
  stats,
  strings,
  onJumpToString,
  onJumpToOffset,
  showToast,
}: SidebarAnalyzeProps) {
  return (
    <div className="analyze-body">
      <div className="analyze-scroll">
        <EntropySection
          tabId={tabId}
          meta={meta}
          digits={digits}
          onJumpToOffset={onJumpToOffset}
          showToast={showToast}
        />
        <HistogramSection
          tabId={tabId}
          meta={meta}
          stats={stats}
          onJumpToOffset={onJumpToOffset}
          showToast={showToast}
        />
        <StringSection
          meta={meta}
          digits={digits}
          strings={strings}
          onJumpToString={onJumpToString}
          showToast={showToast}
        />
      </div>
      <ChecksumSection
        tabId={tabId}
        meta={meta}
        selection={selection}
        digits={digits}
        showToast={showToast}
      />
    </div>
  );
}

/* ---------------- 熵图 ---------------- */

/** 熵图可选块大小（实际块数上限约 4000，超大文件后端自动加大块） */
const ENTROPY_BLOCKS = [64, 256, 1024, 4096] as const;
/** 色带高度（px） */
const ENTROPY_HEIGHT = 40;

/** 熵值 0..8 → 冷（蓝）到暖（红）色 */
function entropyColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  return `hsl(${220 - c * 220} 75% ${28 + c * 34}%)`;
}

function EntropySection({
  tabId,
  meta,
  digits,
  onJumpToOffset,
  showToast,
}: {
  tabId: string;
  meta: FileMeta | null;
  digits: number;
  onJumpToOffset: (offset: number) => void;
  showToast: (msg: string) => void;
}) {
  const [blockSize, setBlockSize] = useState<number>(256);
  const [data, setData] = useState<number[] | null>(null);
  const [computing, setComputing] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 悬停计算用的最新数据（避免 effect 重建 mousemove 闭包） */
  const dataRef = useRef<number[]>([]);

  // 拉取熵数据（打开 / 保存 / 块大小变化时；基于磁盘内容）
  useEffect(() => {
    if (!meta || meta.size === 0) {
      setData(null);
      dataRef.current = [];
      return;
    }
    let alive = true;
    setComputing(true);
    invoke<number[]>('compute_entropy', { tabId, blockSize })
      .then(d => {
        if (!alive) return;
        dataRef.current = d;
        setData(d);
      })
      .catch(e => {
        if (alive) showToast(`熵计算失败: ${e}`);
      })
      .finally(() => {
        if (alive) setComputing(false);
      });
    return () => {
      alive = false;
    };
    // meta 对象身份仅在打开 / 保存（重新 mmap）时变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, meta, blockSize]);

  // 绘制色带
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap || !data || data.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, wrap.clientWidth);
    const h = ENTROPY_HEIGHT;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = data.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = entropyColor(data[i] / 8);
      ctx.fillRect(i * bw, 0, Math.max(bw, 1), h);
    }
    dataRef.current = data;
  }, [data]);

  /** 鼠标位置 → 块索引与偏移范围提示 */
  const locate = (e: React.MouseEvent): { text: string; start: number } | null => {
    const wrap = wrapRef.current;
    const n = dataRef.current.length;
    if (!wrap || !meta || n === 0) return null;
    const rect = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
    const actual = Math.ceil(meta.size / n);
    const start = i * actual;
    const end = Math.min(meta.size - 1, start + actual - 1);
    return {
      text: `${hexOffset(start, digits)} – ${hexOffset(Math.max(start, end), digits)} · 熵 ${dataRef.current[i].toFixed(2)}`,
      start,
    };
  };

  return (
    <div className="side-section">
      <h3>
        熵图
        <span className="side-progress-text">{computing ? '计算中…' : ''}</span>
      </h3>
      {!meta || meta.size === 0 ? (
        <p className="placeholder-text">打开文件后可用</p>
      ) : (
        <>
          <div className="edit-opt">
            <span className="edit-label">块大小</span>
            <div className="seg">
              {ENTROPY_BLOCKS.map(b => (
                <button
                  key={b}
                  className={blockSize === b ? 'on' : ''}
                  onClick={() => setBlockSize(b)}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={wrapRef}
            className="entropy-band"
            onMouseMove={e => {
              const hit = locate(e);
              if (hit) setHover({ x: e.clientX, y: e.clientY, text: hit.text });
            }}
            onMouseLeave={() => setHover(null)}
            onClick={e => {
              const hit = locate(e);
              if (hit) onJumpToOffset(hit.start);
            }}
            title="点击跳转到该块起始位置"
          >
            <canvas ref={canvasRef} />
          </div>
          <p className="side-progress-text">悬停查看偏移范围与熵值 · 点击跳转（基于磁盘内容）</p>
        </>
      )}
      {hover && (
        <div className="chart-tip mono" style={{ left: hover.x + 12, top: hover.y - 30 }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

/* ---------------- 字节分布直方图 ---------------- */

const HIST_HEIGHT = 80;
const HIST_BINS = 256;

function HistogramSection({
  tabId,
  meta,
  stats,
  onJumpToOffset,
  showToast,
}: {
  tabId: string;
  meta: FileMeta | null;
  stats: FileStats | null;
  onJumpToOffset: (offset: number) => void;
  showToast: (msg: string) => void;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const hist = stats?.histogram;
  const svgRef = useRef<SVGSVGElement>(null);

  /** 对数纵轴的柱高（0 也显示最小可见高度） */
  const bars = useMemo(() => {
    if (!hist || hist.length !== HIST_BINS) return null;
    let max = 0;
    for (const c of hist) if (c > max) max = c;
    if (max === 0) return null;
    const lg = Math.log10(1 + max);
    return hist.map(c => ({
      h: (Math.log10(1 + c) / lg) * (HIST_HEIGHT - 2) + (c > 0 ? 1 : 0),
      count: c,
    }));
  }, [hist]);

  const total = stats?.total ?? 0;

  /** 鼠标位置 → bin 提示 */
  const locate = (e: React.MouseEvent): { text: string; bin: number } | null => {
    const svg = svgRef.current;
    if (!svg || !bars) return null;
    const rect = svg.getBoundingClientRect();
    const bin = Math.max(
      0,
      Math.min(HIST_BINS - 1, Math.floor(((e.clientX - rect.left) / rect.width) * HIST_BINS)),
    );
    const count = bars[bin].count;
    const ch = bin >= 0x20 && bin <= 0x7e ? ` '${String.fromCharCode(bin)}'` : '';
    const pct = total > 0 ? ((count / total) * 100).toFixed(2) : '0';
    return { text: `0x${bin.toString(16).padStart(2, '0').toUpperCase()}${ch} · ${count} 次 · ${pct}%`, bin };
  };

  /** 点击 bin：跳到该字节值首次出现位置 */
  const jump = async (bin: number) => {
    try {
      const pos = await invoke<number | null>('find_first_byte', { tabId, value: bin });
      if (pos === null) showToast('文件中没有该字节值');
      else onJumpToOffset(pos);
    } catch (err) {
      showToast(`查找失败: ${err}`);
    }
  };

  return (
    <div className="side-section">
      <h3>字节分布</h3>
      {!meta || meta.size === 0 ? (
        <p className="placeholder-text">打开文件后可用</p>
      ) : !bars ? (
        <p className="placeholder-text">{stats ? '无数据' : '统计扫描中…'}</p>
      ) : (
        <>
          <svg
            ref={svgRef}
            className="hist-chart"
            viewBox={`0 0 ${HIST_BINS} ${HIST_HEIGHT}`}
            preserveAspectRatio="none"
            onMouseMove={e => {
              const hit = locate(e);
              if (hit) setHover({ x: e.clientX, y: e.clientY, text: hit.text });
            }}
            onMouseLeave={() => setHover(null)}
            onClick={e => {
              const hit = locate(e);
              if (hit) void jump(hit.bin);
            }}
          >
            {bars.map((b, i) => (
              <rect
                key={i}
                x={i}
                y={HIST_HEIGHT - b.h}
                width={1}
                height={b.h}
                className="hist-bar"
              />
            ))}
          </svg>
          <p className="side-progress-text">对数纵轴 · 悬停查看计数 · 点击跳转（基于磁盘内容）</p>
        </>
      )}
      {hover && (
        <div className="chart-tip mono" style={{ left: hover.x + 12, top: hover.y - 30 }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

/* ---------------- 字符串提取 ---------------- */

function StringSection({
  meta,
  digits,
  strings,
  onJumpToString,
  showToast,
}: {
  meta: FileMeta | null;
  digits: number;
  strings: StringExtractState;
  onJumpToString: (hit: StringHit) => void;
  showToast: (msg: string) => void;
}) {
  const [minLength, setMinLength] = useState(4);
  const [encodings, setEncodings] = useState<StringEncoding[]>([
    'ascii',
    'utf-8',
    'utf-16le',
    'utf-16be',
  ]);
  const lenRef = useRef<HTMLInputElement>(null);

  const toggleEnc = (enc: StringEncoding) => {
    setEncodings(es => (es.includes(enc) ? es.filter(e => e !== enc) : [...es, enc]));
  };

  const doRefresh = () => {
    const n = parseInt(minLength.toString(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 1024) {
      showToast('最小长度需为 1–1024');
      lenRef.current?.focus();
      return;
    }
    setMinLength(n);
    strings.refresh(n, encodings);
  };

  const hidden = strings.total - strings.hits.length;

  return (
    <div className="side-section">
      <h3>
        字符串提取
        <span className="side-progress-text">
          {strings.running ? '扫描中…' : strings.hits.length > 0 ? `${strings.total} 条` : ''}
        </span>
      </h3>
      {!meta ? (
        <p className="placeholder-text">尚未打开文件</p>
      ) : (
        <>
          <div className="str-filter-row">
            <input
              ref={lenRef}
              className="input str-min-len"
              type="number"
              min={1}
              max={1024}
              value={minLength}
              onChange={e => setMinLength(parseInt(e.target.value, 10) || 0)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') doRefresh();
              }}
              title="最小长度（字符数）"
            />
            <button className="btn mini" onClick={doRefresh} disabled={strings.running}>
              刷新
            </button>
          </div>
          <label className="enc-checks">
            {(['ascii', 'utf-8', 'utf-16le', 'utf-16be'] as StringEncoding[]).map(enc => (
              <label key={enc} className="enc-check">
                <input
                  type="checkbox"
                  checked={encodings.includes(enc)}
                  onChange={() => toggleEnc(enc)}
                />
                {ENC_LABELS[enc]}
              </label>
            ))}
          </label>
          {strings.error && <p className="side-error">{strings.error}</p>}
          {!strings.error && strings.hits.length === 0 && !strings.running && (
            <p className="placeholder-text">
              {strings.total === 0 ? '无匹配字符串，可尝试减小最小长度' : ''}
            </p>
          )}
          {hidden > 0 && (
            <p className="placeholder-text">还有 {hidden} 条未显示，可增大最小长度</p>
          )}
          <ul className="str-list">
            {strings.hits.map((h, i) => (
              <li key={`${h.offset}-${i}`} className="str-item" onClick={() => onJumpToString(h)}>
                <span className="str-meta">
                  <span className="str-enc-tag">{ENC_LABELS[h.encoding]}</span>
                  <span>{hexOffset(h.offset, digits)}</span>
                  <span>{h.length} B</span>
                  <button
                    className="insp-copy"
                    title="复制字符串"
                    onClick={e => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(h.text).then(
                        () => showToast('字符串已复制'),
                        () => showToast('复制失败'),
                      );
                    }}
                  >
                    复制
                  </button>
                </span>
                <span className="str-text" title={h.text}>
                  {h.text}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------------- 校验和 ---------------- */

function ChecksumSection({
  tabId,
  meta,
  selection,
  digits,
  showToast,
}: {
  tabId: string;
  meta: FileMeta | null;
  selection: Selection | null;
  digits: number;
  showToast: (msg: string) => void;
}) {
  const [result, setResult] = useState<Checksums | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  /** 长哈希详情弹窗（点击 MD5/SHA-1/SHA-256 等长值查看完整内容） */
  const [detail, setDetail] = useState<{ name: string; value: string } | null>(null);
  const cacheRef = useRef(new Map<string, Checksums>());

  const selStart = selection?.start ?? -1;
  const selEnd = selection?.end ?? -1;

  // meta 引用仅在打开 / 保存（重新 mmap）时变化 → 磁盘内容已变，缓存失效；
  // 普通滚动触发的分片缓存版本号 bump 不会传到这里，避免误清
  useEffect(() => {
    cacheRef.current.clear();
  }, [meta]);

  // 选中区间变化 → 200ms 防抖重算；同区间命中缓存
  useEffect(() => {
    if (!meta || !selection) {
      setResult(null);
      setError(null);
      return;
    }
    const len = selEnd - selStart + 1;
    if (len > MAX_CK_LEN) {
      setResult(null);
      setError(`选择过大（${len} 字节），仅支持 4MB 以内`);
      return;
    }
    const key = `${selStart}:${len}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setResult(cached);
      setError(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      setComputing(true);
      try {
        const r = await invoke<Checksums>('compute_checksums', {
          tabId,
          offset: selStart,
          len,
        });
        if (!alive) return;
        cacheRef.current.set(key, r);
        if (cacheRef.current.size > CK_CACHE_MAX) {
          cacheRef.current.delete(cacheRef.current.keys().next().value as string);
        }
        setResult(r);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setComputing(false);
      }
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, meta, selStart, selEnd]);

  const copyRow = (name: string, value: string) => {
    navigator.clipboard.writeText(value).then(
      () => showToast(`${name} 已复制`),
      () => showToast('复制失败'),
    );
  };

  const copyAll = () => {
    if (!result) return;
    const text = CK_ROWS.map(r => `${r.name}: ${result[r.key]}`).join('\n');
    navigator.clipboard.writeText(text).then(
      () => showToast('校验和已全部复制'),
      () => showToast('复制失败'),
    );
  };

  return (
    <>
      <div className="side-section ck-fixed">
        <h3>
          校验和
          {result && (
            <button className="btn mini" onClick={copyAll}>
              复制全部
            </button>
          )}
        </h3>
        {!meta ? (
          <p className="placeholder-text">尚未打开文件</p>
        ) : !selection ? (
          <p className="placeholder-text">请先选择一段区间</p>
        ) : error ? (
          <p className="side-error">{error}</p>
        ) : !result ? (
          <p className="placeholder-text">{computing ? '计算中…' : ''}</p>
        ) : (
          <>
            <p className="side-progress-text">
              {hexOffset(selStart, digits)} – {hexOffset(selEnd, digits)}（{result.len} 字节）
            </p>
            <div className="ck-grid">
              {CK_ROWS.map(r => {
                const value = result[r.key] as string;
                const long = value.length > CK_DETAIL_THRESHOLD;
                return (
                  <div key={r.key} className="ck-row">
                    <span className="ck-name">{r.name}</span>
                    <span
                      className={`ck-value mono${long ? ' clickable' : ''}`}
                      title={long ? '点击查看完整内容' : undefined}
                      onClick={long ? () => setDetail({ name: r.name, value }) : undefined}
                    >
                      {value}
                    </span>
                    <button
                      className="insp-copy"
                      title={`复制 ${r.name}`}
                      onClick={() => copyRow(r.name, value)}
                    >
                      复制
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="ck-note">基于磁盘内容计算，不含未保存编辑。</p>
          </>
        )}
      </div>
      {detail && (
        <ChecksumDetailModal
          name={detail.name}
          value={detail.value}
          onCopy={() => copyRow(detail.name, detail.value)}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}

/* ---------------- 长哈希详情弹窗 ---------------- */

function ChecksumDetailModal({
  name,
  value,
  onCopy,
  onClose,
}: {
  name: string;
  value: string;
  onCopy: () => void;
  onClose: () => void;
}) {
  // Escape 关闭（弹窗打开期间全局快捷键已被 .modal 存在性检测拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-mask">
      <div className="modal ck-detail" role="dialog" aria-label={`${name} 完整值`}>
        <div className="modal-title">{name}</div>
        <div className="modal-body">
          <div className="ck-detail-value mono">{value}</div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCopy}>
            复制
          </button>
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
