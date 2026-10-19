import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { HexViewer, type HexViewerHandle } from './HexViewer';
import { useFileWindow } from '../hooks/useFileWindow';
import type { DiffRange, DisplayConfig, Selection } from '../types';
import { formatBytes } from '../utils/format';

/** 超过该大小提示对比可能较慢（方案约定 100MB） */
const DIFF_WARN_SIZE = 100 * 1024 * 1024;

const EMPTY_EDITS: ReadonlyMap<number, number> = new Map();

/**
 * 区间命中集合：has() 二分实现（对比差异可能覆盖海量字节，不能展开成逐字节 Set）。
 * 以鸭子类型满足 Row 的 hitSet: ReadonlySet<number>（Row 只调用 has()）。
 */
class RangeSet {
  private ranges: Array<[number, number]>; // 已排序、合并的 [start, end]
  constructor(input: DiffRange[]) {
    const sorted = [...input]
      .map(d => [d.start, d.start + d.len - 1] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) {
        if (r[1] > last[1]) last[1] = r[1];
      } else {
        merged.push([r[0], r[1]]);
      }
    }
    this.ranges = merged;
  }
  has(o: number): boolean {
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid];
      if (o < r[0]) hi = mid - 1;
      else if (o > r[1]) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

interface DiffTabProps {
  tabId: string;
  pathA: string;
  pathB: string;
  active: boolean;
  config: DisplayConfig;
  showToast: (msg: string) => void;
}

/**
 * 对比标签页（v1.1.4）：左右两个只读 HexViewer 按行号同步滚动，
 * 差异区间高亮（Rust 4MB 块扫描 + 相邻合并），支持上一处/下一处导航。
 * 两文件以后端子标签（`${tabId}-a/b`）独立 mmap，关闭时随组件卸载释放。
 */
export function DiffTab({ tabId, pathA, pathB, active, config, showToast }: DiffTabProps) {
  const winA = useFileWindow(`${tabId}-a`);
  const winB = useFileWindow(`${tabId}-b`);

  const [diffs, setDiffs] = useState<DiffRange[] | null>(null);
  const [computing, setComputing] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [curDiff, setCurDiff] = useState(-1);

  const [selA, setSelA] = useState<Selection | null>(null);
  const [selB, setSelB] = useState<Selection | null>(null);
  const [hoverA, setHoverA] = useState<number | null>(null);
  const [hoverB, setHoverB] = useState<number | null>(null);

  const viewerARef = useRef<HexViewerHandle>(null);
  const viewerBRef = useRef<HexViewerHandle>(null);
  /** 同步滚动方向锁：'a'=A 刚驱动 B（此刻 B 的回调是回声，跳过） */
  const syncFromRef = useRef<'a' | 'b' | null>(null);

  /** 挂载代数：cleanup 延迟关闭时校验，避免误关"更新一次挂载"的子标签 */
  const mountGenRef = useRef(0);

  // 挂载即打开两个文件（path 生命周期内不变；失败内联展示），
  // 并在"本次挂载"的两个 open 都完成后计算差异。
  // 注意：实测 StrictMode 下模拟卸载的 close_tab 请求可能晚于
  // 重新挂载的 open_file 到达后端（IPC 交错），无条件 close 会把
  // 新打开的子标签删掉导致 diff 报"尚未打开"。因此 close 延迟执行
  // 并用代数守卫：期间若发生重新挂载（代数变化）则跳过。
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    const gen = ++mountGenRef.current;
    let alive = true;
    Promise.all([winA.openFile(pathA), winB.openFile(pathB)])
      .then(([ma, mb]) => {
        if (!alive) return;
        if (ma.size > DIFF_WARN_SIZE || mb.size > DIFF_WARN_SIZE) {
          showToast('文件较大，对比可能需要一些时间');
        }
        setComputing(true);
        setDiffError(null);
        return invoke<DiffRange[]>('diff_files', { tabIdA: `${tabId}-a`, tabIdB: `${tabId}-b` })
          .then(rs => {
            if (!alive) return;
            setDiffs(rs);
            setCurDiff(rs.length > 0 ? 0 : -1);
          })
          .catch(e => {
            if (alive) setDiffError(`差异计算失败: ${e}`);
          })
          .finally(() => {
            if (alive) setComputing(false);
          });
      })
      .catch(e => {
        if (alive) setOpenError(`打开文件失败: ${e}`);
      });
    return () => {
      alive = false;
      // 卸载：释放两个后端子标签的 mmap（对比页只读，无编辑需要保存）。
      // 延迟 + 代数守卫（原因见上），等待可能的重新挂载先递增代数。
      window.setTimeout(() => {
        if (mountGenRef.current !== gen) return;
        invoke('close_tab', { tabId: `${tabId}-a` }).catch(() => {});
        invoke('close_tab', { tabId: `${tabId}-b` }).catch(() => {});
      }, 300);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathA, pathB]);

  const metaA = winA.fileMeta;
  const metaB = winB.fileMeta;

  /** 差异字节集合（共享单个对象：引用稳定，Row memo 生效；has 为二分；鸭子类型满足 hitSet） */
  const markSet = useMemo(
    () =>
      diffs && diffs.length > 0 ? (new RangeSet(diffs) as unknown as ReadonlySet<number>) : null,
    [diffs],
  );

  /** 按行号同步滚动（用户滚动驱动另一侧对齐到相同首行） */
  const handleVisibleA = useCallback(
    (startByte: number) => {
      if (syncFromRef.current === 'b') {
        syncFromRef.current = null;
        return;
      }
      syncFromRef.current = 'a';
      viewerBRef.current?.scrollToRowTop(Math.floor(startByte / config.bytesPerRow));
    },
    [config.bytesPerRow],
  );
  const handleVisibleB = useCallback(
    (startByte: number) => {
      if (syncFromRef.current === 'a') {
        syncFromRef.current = null;
        return;
      }
      syncFromRef.current = 'b';
      viewerARef.current?.scrollToRowTop(Math.floor(startByte / config.bytesPerRow));
    },
    [config.bytesPerRow],
  );

  /** 跳到第 i 处差异（两侧对齐滚动到区间起始行） */
  const gotoDiff = useCallback(
    (i: number) => {
      if (!diffs || diffs.length === 0) return;
      const idx = ((i % diffs.length) + diffs.length) % diffs.length;
      setCurDiff(idx);
      const row = Math.floor(diffs[idx].start / config.bytesPerRow);
      viewerARef.current?.scrollToRowTop(row);
      viewerBRef.current?.scrollToRowTop(row);
    },
    [diffs, config.bytesPerRow],
  );

  const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const diffCount = diffs?.length ?? 0;

  return (
    <div className={`tab-pane${active ? ' active' : ''}`}>
      <div className="tab-inner">
        <div className="diff-toolbar">
          <span className="diff-title" title={pathA}>
            左：{nameOf(pathA)}
            {metaA ? `（${formatBytes(metaA.size)}）` : ''}
          </span>
          <span className="diff-title" title={pathB}>
            右：{nameOf(pathB)}
            {metaB ? `（${formatBytes(metaB.size)}）` : ''}
          </span>
          <span className="diff-count">
            {computing
              ? '差异计算中…'
              : diffError
                ? diffError
                : diffs === null
                  ? '等待文件就绪…'
                  : diffCount === 0
                    ? '内容完全一致'
                    : `${diffCount} 处差异`}
          </span>
          {diffCount > 0 && (
            <>
              <span className="mono">
                {curDiff + 1}/{diffCount}
              </span>
              <button className="btn mini" onClick={() => gotoDiff(curDiff - 1)}>
                ‹ 上一处
              </button>
              <button className="btn mini" onClick={() => gotoDiff(curDiff + 1)}>
                下一处 ›
              </button>
            </>
          )}
        </div>
        {openError ? (
          <div className="hex-viewer hex-viewer-empty">
            <div className="empty-state">{openError}</div>
          </div>
        ) : !metaA || !metaB ? (
          <div className="hex-viewer hex-viewer-empty">
            <div className="empty-state">正在打开文件…</div>
          </div>
        ) : (
          <div className="diff-panes">
            <HexViewer
              key={`${tabId}-a`}
              ref={viewerARef}
              meta={metaA}
              config={config}
              cacheVersion={winA.cacheVersion}
              getBytes={winA.getBytes}
              onVisibleRangeChange={handleVisibleA}
              selection={selA}
              onSelectionChange={setSelA}
              hoverOffset={hoverA}
              onHoverOffsetChange={setHoverA}
              cursorOffset={null}
              onCursorChange={() => {}}
              flashOffset={null}
              onZoom={() => {}}
              bookmarks={[]}
              edits={EMPTY_EDITS}
              editMode="dialog"
              editTarget={null}
              onEditStart={() => {}}
              onEditCommit={() => {}}
              onEditCancel={() => {}}
              readOnly
              hitOffsets={null}
              activeHitOffset={null}
              markSet={markSet}
              selectionAnchor={null}
              onSelectionAnchorChange={() => {}}
            />
            <HexViewer
              key={`${tabId}-b`}
              ref={viewerBRef}
              meta={metaB}
              config={config}
              cacheVersion={winB.cacheVersion}
              getBytes={winB.getBytes}
              onVisibleRangeChange={handleVisibleB}
              selection={selB}
              onSelectionChange={setSelB}
              hoverOffset={hoverB}
              onHoverOffsetChange={setHoverB}
              cursorOffset={null}
              onCursorChange={() => {}}
              flashOffset={null}
              onZoom={() => {}}
              bookmarks={[]}
              edits={EMPTY_EDITS}
              editMode="dialog"
              editTarget={null}
              onEditStart={() => {}}
              onEditCommit={() => {}}
              onEditCancel={() => {}}
              readOnly
              hitOffsets={null}
              activeHitOffset={null}
              markSet={markSet}
              selectionAnchor={null}
              onSelectionAnchorChange={() => {}}
            />
          </div>
        )}
      </div>
    </div>
  );
}
