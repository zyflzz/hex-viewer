/**
 * 右侧栏多编码行级解码。
 *
 * 输出与行内字节 1:1 对齐的 DisplayCell 数组：
 * - units > 0：多字节/单字节字符的首字节位，char 为显示字形，units 为占据的字节位宽度
 * - units === 0：多字节字符的后续字节位，不显示字形、不占宽度（保留 span 以维持逐字节结构）
 * - state：normal 正常 / cut 行末截断（显示 ·）/ invalid 非法序列（显示 �）
 *
 * 每行独立解码、不跨行；行永远不会跨 64KB 分片，getBytes 一次返回完整一行。
 */
import type { TextEncoding } from '../types';

export type CellState = 'normal' | 'cut' | 'invalid';

export interface DisplayCell {
  /** 显示字符；'' 表示多字节字符的后续字节位 */
  char: string;
  /** 占据的字节位宽度；0 表示多字节字符的后续字节位 */
  units: number;
  state: CellState;
}

const CUT_CHAR = '·';
const INVALID_CHAR = '\uFFFD';

export const ENCODING_OPTIONS: ReadonlyArray<{ value: TextEncoding; label: string }> = [
  { value: 'ascii', label: 'ASCII' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
];

export const ENCODING_VALUES: readonly TextEncoding[] = ENCODING_OPTIONS.map(o => o.value);

export function encodingLabel(e: TextEncoding): string {
  return ENCODING_OPTIONS.find(o => o.value === e)?.label ?? 'ASCII';
}

/** 解码后按码位判断是否可打印：控制字符、零宽字符、非字符统一显示 '.' */
function isPrintableCp(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0x9f) return false; // C1 控制字符
  if (cp >= 0x200b && cp <= 0x200f) return false; // 零宽字符
  if (cp >= 0x2028 && cp <= 0x202e) return false; // 行/段落分隔与方向控制
  if (cp === 0xfeff) return false; // BOM 零宽不换行空格
  if (cp >= 0xfdd0 && cp <= 0xfdef) return false; // 非字符区
  if (cp === 0xfffe || cp === 0xffff) return false; // 非字符结尾
  return true;
}

function cellOf(ch: string, units: number, state: CellState): DisplayCell {
  return { char: ch, units, state };
}

/** ASCII：0x20–0x7E 显示原字符，其余 '.'（与既有行为完全一致） */
function decodeAscii(bytes: Uint8Array, out: DisplayCell[]): void {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[i] = cellOf(b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.', 1, 'normal');
  }
}

/**
 * UTF-8 手写解析（TextDecoder 的 fatal 模式无法区分"截断"与"非法"）：
 * - 首字节 0xC2–0xDF / 0xE0–0xEF / 0xF0–0xF4 判定序列长度
 * - 续字节须为 0x80–0xBF，码位须≥最小值（排除超长）、不含代理区、不超 U+10FFFF
 * - 行末不完整：从序列首字节起每个字节显示 ·（cut）
 * - 非法：从首字节起按单字节显示 � 并前进 1，后续字节重新尝试解码
 */
function decodeUtf8(bytes: Uint8Array, out: DisplayCell[]): void {
  const len = bytes.length;
  let i = 0;
  while (i < len) {
    const b = bytes[i];
    if (b < 0x80) {
      out[i] = cellOf(isPrintableCp(b) ? String.fromCharCode(b) : '.', 1, 'normal');
      i++;
      continue;
    }
    let seqLen: number;
    let minCp: number;
    if (b >= 0xc2 && b <= 0xdf) {
      seqLen = 2;
      minCp = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      seqLen = 3;
      minCp = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      seqLen = 4;
      minCp = 0x10000;
    } else {
      // 孤立续字节 / 超长首字节（C0、C1）/ 超出 U+10FFFF 的首字节（F5–FF）
      out[i] = cellOf(INVALID_CHAR, 1, 'invalid');
      i++;
      continue;
    }
    // 先校验行内已存在的续字节：已非法则按非法处理（单字节前进）
    let cp = b & (seqLen === 2 ? 0x1f : seqLen === 3 ? 0x0f : 0x07);
    let ok = true;
    const avail = Math.min(seqLen - 1, len - i - 1);
    for (let j = 1; j <= avail; j++) {
      const c = bytes[i + j];
      if ((c & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) {
      out[i] = cellOf(INVALID_CHAR, 1, 'invalid');
      i++;
      continue;
    }
    // 已存在的续字节均合法但序列越过行尾：从首字节起每个字节显示 ·（cut）
    if (i + seqLen > len) {
      for (let j = i; j < len; j++) out[j] = cellOf(CUT_CHAR, 1, 'cut');
      return;
    }
    if (cp < minCp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out[i] = cellOf(INVALID_CHAR, 1, 'invalid');
      i++;
      continue;
    }
    out[i] = cellOf(isPrintableCp(cp) ? String.fromCodePoint(cp) : '.', seqLen, 'normal');
    for (let j = 1; j < seqLen; j++) out[i + j] = cellOf('', 0, 'normal');
    i += seqLen;
  }
}

/** GBK 双字节字符用共享 TextDecoder 解码（按 2 字节子序列、非流式，天然无状态） */
let gbkDecoder: TextDecoder | null = null;
let gbkDecoderChecked = false;

function getGbkDecoder(): TextDecoder | null {
  if (!gbkDecoderChecked) {
    gbkDecoderChecked = true;
    try {
      gbkDecoder = new TextDecoder('gbk');
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder;
}

/**
 * GBK：0x00–0x7F 单字节同 ASCII；0x81–0xFE 为双字节首字节，次字节 0x40–0xFE（非 0x7F）。
 * - 行末孤立首字节：显示 ·（cut），不跨行
 * - 次字节越界：首字节显示 �（invalid），前进 1 字节
 * - 语法合法但未定义的字符对：整个字符对显示 �（invalid），前进 2 字节
 */
function decodeGbk(bytes: Uint8Array, out: DisplayCell[]): void {
  const len = bytes.length;
  const dec = getGbkDecoder();
  let i = 0;
  while (i < len) {
    const b = bytes[i];
    if (b < 0x80) {
      out[i] = cellOf(isPrintableCp(b) ? String.fromCharCode(b) : '.', 1, 'normal');
      i++;
      continue;
    }
    if (b < 0x81 || b > 0xfe) {
      // 0x80 / 0xFF 不是合法的单字节也不是合法的首字节
      out[i] = cellOf(INVALID_CHAR, 1, 'invalid');
      i++;
      continue;
    }
    if (i + 1 >= len) {
      out[i] = cellOf(CUT_CHAR, 1, 'cut');
      return;
    }
    const b2 = bytes[i + 1];
    if (b2 < 0x40 || b2 > 0xfe || b2 === 0x7f) {
      out[i] = cellOf(INVALID_CHAR, 1, 'invalid');
      i++;
      continue;
    }
    let ch: string | null = null;
    if (dec) {
      const s = dec.decode(bytes.subarray(i, i + 2));
      if (s.length === 1 && s !== INVALID_CHAR) ch = s;
    }
    if (ch === null) {
      out[i] = cellOf(INVALID_CHAR, 2, 'invalid');
    } else {
      out[i] = cellOf(isPrintableCp(ch.codePointAt(0) ?? 0) ? ch : '.', 2, 'normal');
    }
    out[i + 1] = cellOf('', 0, 'normal');
    i += 2;
  }
}

/**
 * UTF-16 LE / BE：每 2 字节一个码元，代理对（4 字节）为一个字符。
 * - 码元落在 BMP（非代理区）：字符显示在首字节位，占 2 字节位宽
 * - 落单代理（高或低）：该码元显示 �（invalid），前进 2 字节
 * - 行末奇数字节 / 代理对被行末截断：从截断处起每个字节显示 ·（cut）
 */
function decodeUtf16(bytes: Uint8Array, out: DisplayCell[], littleEndian: boolean): void {
  const len = bytes.length;
  const readUnit = (i: number): number =>
    littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];

  let i = 0;
  while (i < len) {
    if (i + 1 >= len) {
      out[i] = cellOf(CUT_CHAR, 1, 'cut');
      return;
    }
    const u = readUnit(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 3 >= len) {
        for (let j = i; j < len; j++) out[j] = cellOf(CUT_CHAR, 1, 'cut');
        return;
      }
      const u2 = readUnit(i + 2);
      if (u2 >= 0xdc00 && u2 <= 0xdfff) {
        const cp = 0x10000 + ((u - 0xd800) << 10) + (u2 - 0xdc00);
        out[i] = cellOf(isPrintableCp(cp) ? String.fromCodePoint(cp) : '.', 4, 'normal');
        for (let j = 1; j < 4; j++) out[i + j] = cellOf('', 0, 'normal');
        i += 4;
      } else {
        out[i] = cellOf(INVALID_CHAR, 2, 'invalid');
        out[i + 1] = cellOf('', 0, 'normal');
        i += 2;
      }
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      out[i] = cellOf(INVALID_CHAR, 2, 'invalid');
      out[i + 1] = cellOf('', 0, 'normal');
      i += 2;
    } else {
      out[i] = cellOf(isPrintableCp(u) ? String.fromCharCode(u) : '.', 2, 'normal');
      out[i + 1] = cellOf('', 0, 'normal');
      i += 2;
    }
  }
}

/** 对一行字节按指定编码解码，返回与字节 1:1 对齐的显示单元数组 */
export function decodeRow(bytes: Uint8Array, encoding: TextEncoding): DisplayCell[] {
  const out: DisplayCell[] = new Array(bytes.length);
  switch (encoding) {
    case 'utf-8':
      decodeUtf8(bytes, out);
      break;
    case 'gbk':
      decodeGbk(bytes, out);
      break;
    case 'utf-16le':
      decodeUtf16(bytes, out, true);
      break;
    case 'utf-16be':
      decodeUtf16(bytes, out, false);
      break;
    default:
      decodeAscii(bytes, out);
      break;
  }
  return out;
}

/** 复制用解码器的共享缓存（非流式、无状态，可安全复用；null 表示该编码不受支持） */
const textDecoders = new Map<string, TextDecoder | null>();

function getTextDecoder(label: string): TextDecoder | null {
  const cached = textDecoders.get(label);
  if (cached !== undefined) return cached;
  let dec: TextDecoder | null = null;
  try {
    dec = new TextDecoder(label);
  } catch {
    dec = null;
  }
  textDecoders.set(label, dec);
  return dec;
}

/**
 * 把任意长度的字节区间解码为可复制文本（用于剪贴板）。
 * 与 decodeRow（行级显示）不同：这里跨行流式解码，多字节字符不受行边界影响；
 * 非法/被截断的序列由 TextDecoder 自动替换为 U+FFFD。
 * ASCII 保持既有复制习惯：0x20–0x7E 原字符，其余 '.'。
 */
export function decodeBytesToText(bytes: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'ascii') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
    }
    return s;
  }
  const dec = getTextDecoder(encoding);
  if (!dec) return decodeBytesToText(bytes, 'ascii');
  return dec.decode(bytes);
}
