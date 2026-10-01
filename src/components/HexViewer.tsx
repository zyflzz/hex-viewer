import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DisplayConfig, FileMeta, Selection, TextEncoding } from '../types';
import { decodeRow } from '../utils/decode';
import { byteClass, byteToAscii, hexByte, hexOffset, offsetDigits } from '../utils/format';

export interface HexViewerHandle {
  scrollToOffset: (offset: number) => void;
}

interface HexViewerProps {
  meta: FileMeta;
  config: DisplayConfig;
  /** 分片缓存版本号，变化时行数据重新提取 */
  cacheVersion: number;
  getBytes: (offset: number, len: number) => Uint8Array | null;
  onVisibleRangeChange: (startByte: number, endByte: number) => void;
  selection: Selection | null;
  onSelectionChange: (sel: Selection | null) => void;
  hoverOffset: number | null;
  onHoverOffsetChange: (offset: number | null) => void;
  /** 当前光标（键盘导航锚点 / 数据检查器输入源）；空文件为 null */
  cursorOffset: number | null;
  onCursorChange: (offset: number) => void;
  /** 跳转目标（搜索/定位），该行闪烁高亮 */
  flashOffset: number | null;
  onZoom: (delta: number) => void;
}

interface RowProps {
  rowStart: number;
  byteCount: number;
  rowBytes: number;
  fontSize: number;
  rowHeight: number;
  digits: number;
  showAscii: boolean;
  encoding: TextEncoding;
  /** 裁剪到本行的选择区间；无关行为 null，让 memo 跳过重渲染 */
  selRange: [number, number] | null;
  /** 仅当悬停落在本行时为具体偏移 */
  hoverOffset: number | null;
  /** 仅当光标落在本行时为具体偏移 */
  cursorOffset: number | null;
  flash: boolean;
  cacheVersion: number;
  getBytes: (offset: number, len: number) => Uint8Array | null;
}

/**
 * 单行渲染（memo 化）：
 * - data 变化仅发生在分片到达（cacheVersion）时
 * - 选择 / 悬停 / 光标 / 闪烁都以"行内裁剪后的原始值"传入，未涉及的行直接跳过
 */
const Row = React.memo(function Row({
  rowStart,
  byteCount,
  rowBytes,
  fontSize,
  rowHeight,
  digits,
  showAscii,
  encoding,
  selRange,
  hoverOffset,
  cursorOffset,
  flash,
  cacheVersion,
  getBytes,
}: RowProps) {
  const data = useMemo(
    () => getBytes(rowStart, byteCount),
    [getBytes, rowStart, byteCount, cacheVersion],
  );

  // 行级解码（每行独立、不跨行）；data 到达或编码切换时才重新计算
  const cells = useMemo(
    () => (data && data.length > 0 ? decodeRow(data, encoding) : null),
    [data, encoding],
  );

  const half = rowBytes >> 1;
  const [selStart, selEnd] = selRange ?? [-1, -1];
  const hexCells: React.ReactNode[] = [];
  const asciiCells: React.ReactNode[] = [];

  for (let i = 0; i < rowBytes; i++) {
    const off = rowStart + i;
    const exists = i < byteCount;
    const b = exists && data && i < data.length ? data[i] : null;
    const inSel = exists && off >= selStart && off <= selEnd;
    const isHover = exists && off === hoverOffset;
    const isCursor = exists && off === cursorOffset;
    const groupGap = i === half - 1 ? '  ' : ' ';

    if (!exists) {
      // 文件末尾之外：纯占位，保持列对齐
      hexCells.push(<span key={i} className="bs p">{'  ' + groupGap}</span>);
      asciiCells.push(<span key={i} className="bs p"> </span>);
      continue;
    }
    if (b === null) {
      // 分片尚未到达
      const cls = `bs m${inSel ? ' s' : ''}${isHover ? ' v' : ''}${isCursor ? ' cur' : ''}`;
      hexCells.push(
        <span key={i} data-o={off} className={cls}>
          {'--' + groupGap}
        </span>,
      );
      asciiCells.push(
        <span key={i} data-o={off} className={cls}>
          {'·'}
        </span>,
      );
      continue;
    }
    hexCells.push(
      <span
        key={i}
        data-o={off}
        className={`${inSel ? 'bs s' : isHover ? 'bs v' : `bs ${byteClass(b)}`}${isCursor ? ' cur' : ''}`}
      >
        {hexByte(b) + groupGap}
      </span>,
    );

    // 右侧栏：按解码单元渲染，DOM 仍保持每字节一个 span（data-o 为绝对偏移）
    const cell = cells?.[i] ?? { char: byteToAscii(b), units: 1, state: 'normal' as const };
    if (cell.units === 0) {
      // 多字节字符的后续字节位：宽度 0、无字形，保留逐字节结构
      asciiCells.push(<span key={i} data-o={off} className="bs cont" />);
    } else if (cell.units === 1) {
      const stateCls = cell.state === 'cut' ? ' cut' : cell.state === 'invalid' ? ' invalid' : '';
      asciiCells.push(
        <span
          key={i}
          data-o={off}
          className={(inSel ? 'bs s' : isHover ? 'bs v' : `bs ${byteClass(b)}`) + stateCls + (isCursor ? ' cur' : '')}
        >
          {cell.char}
        </span>,
      );
    } else {
      // 多字节字符首字节位：占据 units 个字节位宽度；选择命中任一字节则整个字符高亮
      const cellSel = off <= selEnd && off + cell.units - 1 >= selStart;
      // 光标落在字符任一字节上，整个字符标记光标（ASCII 列视觉完整）
      const cellCursor =
        cursorOffset !== null && cursorOffset >= off && cursorOffset < off + cell.units;
      const stateCls = cell.state === 'cut' ? ' cut' : cell.state === 'invalid' ? ' invalid' : '';
      asciiCells.push(
        <span
          key={i}
          data-o={off}
          className={`${cellSel ? 'bs s' : isHover ? 'bs v' : `bs ${byteClass(b)}`} multi${stateCls}${cellCursor ? ' cur' : ''}`}
          style={{ width: `${cell.units}ch` }}
        >
          {cell.char}
        </span>,
      );
    }
  }

  return (
    <div
      className={`hex-row${flash ? ' flash' : ''}`}
      style={{ height: rowHeight, fontSize, lineHeight: `${rowHeight}px` }}
    >
      <span className="hex-offset">{hexOffset(rowStart, digits)}</span>
      <span className="hex-bytes">{hexCells}</span>
      {showAscii && <span className="hex-ascii">{asciiCells}</span>}
    </div>
  );
});

export const HexViewer = forwardRef<HexViewerHandle, HexViewerProps>(function HexViewer(
  {
    meta,
    config,
    cacheVersion,
    getBytes,
    onVisibleRangeChange,
    selection,
    onSelectionChange,
    hoverOffset,
    onHoverOffsetChange,
    cursorOffset,
    onCursorChange,
    flashOffset,
    onZoom,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragAnchorRef = useRef(0);
  /** Shift 扩展选择的锚点（首次 Shift 导航前的光标位置） */
  const shiftAnchorRef = useRef<number | null>(null);

  const { bytesPerRow: rowBytes, fontSize, showAscii, encoding } = config;
  const rowHeight = Math.round(fontSize * 1.7);
  const digits = offsetDigits(meta.size);
  const totalRows = meta.size === 0 ? 0 : Math.ceil(meta.size / rowBytes);

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  // 字号 / 行字节数变化后重新测量全部行高
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, rowBytes, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToOffset: (offset: number) => {
        virtualizer.scrollToIndex(Math.floor(offset / rowBytes), { align: 'center' });
      },
    }),
    [rowBytes, virtualizer],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const firstRow = virtualItems.length ? virtualItems[0].index : 0;
  const lastRow = virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0;

  // 可见范围变化 → 通知数据层加载分片
  useEffect(() => {
    if (!virtualItems.length || totalRows === 0) return;
    onVisibleRangeChange(firstRow * rowBytes, (lastRow + 1) * rowBytes - 1);
  }, [firstRow, lastRow, rowBytes, totalRows, virtualItems.length, onVisibleRangeChange]);

  // Ctrl+滚轮缩放（原生监听以保证 preventDefault 生效）
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);

  // 松开 Shift 时重置扩展选择锚点
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftAnchorRef.current = null;
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, []);

  // 光标移出可视区域时滚动使其可见（尽量少滚动，避免视觉跳动）。
  // 刻意不依赖 firstRow/lastRow（含 overscan 且随滚动变化），改为直接读滚动容器：
  // 只有 cursorOffset / 行几何变化才触发，用户手动滚动不会被此副作用拉回。
  useEffect(() => {
    if (cursorOffset === null) return;
    const el = parentRef.current;
    if (!el) return;
    const cursorRow = Math.floor(cursorOffset / rowBytes);
    const firstVisible = Math.floor(el.scrollTop / rowHeight);
    const lastVisible = Math.floor((el.scrollTop + el.clientHeight - 1) / rowHeight);
    if (cursorRow < firstVisible) {
      virtualizer.scrollToIndex(cursorRow, { align: 'start' });
    } else if (cursorRow > lastVisible) {
      virtualizer.scrollToIndex(cursorRow, { align: 'end' });
    }
  }, [cursorOffset, rowBytes, rowHeight, virtualizer]);

  /** 键盘导航：移动光标；Shift 扩展选择，非 Shift 折叠选择到光标 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (cursorOffset === null || totalRows === 0) return;
      const max = meta.size - 1;
      const cur = cursorOffset;

      if (e.key === 'Escape') {
        // 选择清空由 App 全局快捷键处理，这里只重置 Shift 锚点
        shiftAnchorRef.current = null;
        return;
      }

      let target: number;
      switch (e.key) {
        case 'ArrowLeft':
          target = cur - 1;
          break;
        case 'ArrowRight':
          target = cur + 1;
          break;
        case 'ArrowUp':
          target = cur - rowBytes;
          break;
        case 'ArrowDown':
          target = cur + rowBytes;
          break;
        case 'Home':
          target = e.ctrlKey || e.metaKey ? 0 : Math.floor(cur / rowBytes) * rowBytes;
          break;
        case 'End':
          target =
            e.ctrlKey || e.metaKey
              ? max
              : Math.min(Math.floor(cur / rowBytes) * rowBytes + rowBytes - 1, max);
          break;
        case 'PageUp':
        case 'PageDown': {
          const el = parentRef.current;
          const pageRows = el ? Math.max(1, Math.floor(el.clientHeight / rowHeight)) : 20;
          target = e.key === 'PageUp' ? cur - pageRows * rowBytes : cur + pageRows * rowBytes;
          break;
        }
        default:
          return;
      }
      e.preventDefault();
      target = Math.max(0, Math.min(target, max));

      if (e.shiftKey) {
        if (shiftAnchorRef.current === null) shiftAnchorRef.current = cur;
        const anchor = shiftAnchorRef.current;
        onSelectionChange({ start: Math.min(anchor, target), end: Math.max(anchor, target) });
      } else {
        shiftAnchorRef.current = null;
        onSelectionChange({ start: target, end: target });
      }
      onCursorChange(target);
    },
    [cursorOffset, totalRows, meta.size, rowBytes, rowHeight, onSelectionChange, onCursorChange],
  );

  const offsetFromEvent = useCallback((e: React.MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest?.('[data-o]');
    if (!el) return null;
    const v = Number((el as HTMLElement).dataset.o);
    return Number.isFinite(v) ? v : null;
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const off = offsetFromEvent(e);
      if (off === null) return;
      e.preventDefault();
      // preventDefault 会阻止默认聚焦，手动聚焦容器以启用键盘导航
      parentRef.current?.focus({ preventScroll: true });
      shiftAnchorRef.current = null;
      if (e.shiftKey && selection) {
        // Shift 点击：以现有选择另一端为锚点扩展
        const anchor = Math.abs(off - selection.start) > Math.abs(off - selection.end)
          ? selection.start
          : selection.end;
        dragAnchorRef.current = anchor;
        onSelectionChange({ start: Math.min(anchor, off), end: Math.max(anchor, off) });
      } else {
        dragAnchorRef.current = off;
        onSelectionChange({ start: off, end: off });
      }
      onCursorChange(off);
      draggingRef.current = true;
    },
    [offsetFromEvent, selection, onSelectionChange, onCursorChange],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const off = offsetFromEvent(e);
      onHoverOffsetChange(off);
      if (draggingRef.current && off !== null) {
        const anchor = dragAnchorRef.current;
        onSelectionChange({ start: Math.min(anchor, off), end: Math.max(anchor, off) });
        // 光标跟随拖拽终点（选择区间的活动端点）
        onCursorChange(off);
      }
    },
    [offsetFromEvent, onHoverOffsetChange, onSelectionChange, onCursorChange],
  );

  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // 行级派生 props（原始值 / null，保证 memo 命中）
  const rowSelRange = useCallback(
    (rowIndex: number): [number, number] | null => {
      if (!selection) return null;
      const rs = rowIndex * rowBytes;
      const re = rs + rowBytes - 1;
      if (selection.end < rs || selection.start > re) return null;
      return [Math.max(selection.start, rs), Math.min(selection.end, re)];
    },
    [selection, rowBytes],
  );

  if (totalRows === 0) {
    return (
      <div className="hex-viewer hex-viewer-empty">
        <div className="empty-state">文件为空</div>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="hex-viewer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => onHoverOffsetChange(null)}
    >
      <div
        className="hex-total"
        style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
      >
        {virtualItems.map(v => {
          const rowStart = v.index * rowBytes;
          const byteCount = Math.min(rowBytes, meta.size - rowStart);
          const hoverInRow =
            hoverOffset !== null && hoverOffset >= rowStart && hoverOffset < rowStart + rowBytes
              ? hoverOffset
              : null;
          const cursorInRow =
            cursorOffset !== null && cursorOffset >= rowStart && cursorOffset < rowStart + rowBytes
              ? cursorOffset
              : null;
          const flash =
            flashOffset !== null && flashOffset >= rowStart && flashOffset < rowStart + rowBytes;
          return (
            <div
              key={v.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 'max-content',
                minWidth: '100%',
                height: v.size,
                transform: `translateY(${v.start}px)`,
              }}
            >
              <Row
                rowStart={rowStart}
                byteCount={byteCount}
                rowBytes={rowBytes}
                fontSize={fontSize}
                rowHeight={rowHeight}
                digits={digits}
                showAscii={showAscii}
                encoding={encoding}
                selRange={rowSelRange(v.index)}
                hoverOffset={hoverInRow}
                cursorOffset={cursorInRow}
                flash={flash}
                cacheVersion={cacheVersion}
                getBytes={getBytes}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
