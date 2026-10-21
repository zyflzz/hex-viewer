/**
 * 选择模型纯函数（v1.1.5 块选择）：
 * 线性选择 { start, end } 与块选择 { mode:'block', ... } 的统一处理层。
 * 所有消费方（复制 / 填充 / 删除 / 粘贴目标 / AI 上下文 / 状态栏）经 normalizeSelection
 * 拿到"区间列表 + 总字节数"，不感知选择的具体形态；渲染层每行仍拿连续区间。
 */
import type { BlockSelection, Selection } from '../types';

export function isBlockSelection(sel: Selection | null): sel is BlockSelection {
  return sel !== null && (sel as BlockSelection).mode === 'block';
}

/** 行内两字节偏移构造块选择（行列有序化） */
export function blockFromOffsets(a: number, b: number, rowBytes: number): BlockSelection {
  const ar = Math.floor(a / rowBytes);
  const br = Math.floor(b / rowBytes);
  const ac = a % rowBytes;
  const bc = b % rowBytes;
  return {
    mode: 'block',
    startRow: Math.min(ar, br),
    endRow: Math.max(ar, br),
    startCol: Math.min(ac, bc),
    endCol: Math.max(ac, bc),
  };
}

/** 线性选择 → 块选择（把区间两端折算成行列并有序化） */
export function linearToBlock(sel: Selection, rowBytes: number): BlockSelection {
  if (isBlockSelection(sel)) return sel;
  return blockFromOffsets(sel.start, sel.end, rowBytes);
}

/** 两个 (行, 列) 单元格之间的块选择（行列各自有序化） */
export function blockFromCells(
  a: { row: number; col: number },
  b: { row: number; col: number },
): BlockSelection {
  return {
    mode: 'block',
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
  };
}

/** 块选择的四个角（行列单元格） */
export function blockCorners(sel: BlockSelection): Array<{ row: number; col: number }> {
  return [
    { row: sel.startRow, col: sel.startCol },
    { row: sel.startRow, col: sel.endCol },
    { row: sel.endRow, col: sel.startCol },
    { row: sel.endRow, col: sel.endCol },
  ];
}

/** 块角中离指定单元格最远的角（块选择扩展时的活动端点） */
export function farthestCorner(
  sel: BlockSelection,
  cell: { row: number; col: number },
): { row: number; col: number } {
  return blockCorners(sel).reduce((best, c) => {
    const d = (a: { row: number; col: number }) =>
      Math.abs(a.row - cell.row) + Math.abs(a.col - cell.col);
    return d(c) > d(best) ? c : best;
  });
}

/** 偏移 → (行, 列) 单元格 */
export function offsetToCell(offset: number, rowBytes: number): { row: number; col: number } {
  return { row: Math.floor(offset / rowBytes), col: offset % rowBytes };
}

/** (行, 列) → 偏移（不钳制，调用方按文件大小处理越界） */
export function cellToOffset(cell: { row: number; col: number }, rowBytes: number): number {
  return cell.row * rowBytes + cell.col;
}

/** 块选择在指定行的实际字节区间（列裁剪到该行实际字节数）；行不在块内返回 null */
export function blockRowRange(
  sel: BlockSelection,
  rowIndex: number,
  rowBytes: number,
  fileSize: number,
): [number, number] | null {
  if (rowIndex < sel.startRow || rowIndex > sel.endRow) return null;
  const rowStart = rowIndex * rowBytes;
  const avail = Math.min(rowBytes, fileSize - rowStart); // 本行实际字节数（末行可能不足）
  if (avail <= 0 || sel.startCol >= avail) return null; // 列范围超出该行长度：跳过超出部分
  const endCol = Math.min(sel.endCol, avail - 1);
  return [rowStart + sel.startCol, rowStart + endCol];
}

export interface NormalizedSelection {
  /** 按行裁剪后的字节区间列表（升序、互不重叠；线性选择为单区间） */
  ranges: Array<[number, number]>;
  /** 区间内总字节数（块选择为各行之和） */
  totalBytes: number;
}

/**
 * 统一适配：任意选择 → 区间列表。文件为空 / 无效选择返回空列表。
 * 边界：最后一行字节数可能不足，列范围超过该行实际长度时裁剪；
 * 偏移超出文件末尾的行整行跳过。
 */
export function normalizeSelection(
  sel: Selection | null,
  rowBytes: number,
  fileSize: number,
): NormalizedSelection {
  if (!sel || fileSize <= 0) return { ranges: [], totalBytes: 0 };
  if (isBlockSelection(sel)) {
    const ranges: Array<[number, number]> = [];
    let total = 0;
    for (let r = sel.startRow; r <= sel.endRow; r++) {
      const range = blockRowRange(sel, r, rowBytes, fileSize);
      if (range) {
        ranges.push(range);
        total += range[1] - range[0] + 1;
      }
    }
    return { ranges, totalBytes: total };
  }
  const start = Math.max(0, Math.min(sel.start, fileSize - 1));
  const end = Math.max(0, Math.min(sel.end, fileSize - 1));
  return { ranges: [[start, end]], totalBytes: end - start + 1 };
}

/** 状态栏选择描述：块选择显示 "块选择 R1:C1 – R2:C2"，线性显示偏移区间（1 基行列号） */
export function describeSelection(sel: Selection | null): string | null {
  if (!sel) return null;
  if (isBlockSelection(sel)) {
    return `块选择 ${sel.startRow + 1}:${sel.startCol + 1} – ${sel.endRow + 1}:${sel.endCol + 1}`;
  }
  return null;
}
