/** 格式化与字节显示工具 */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN');
}

export function formatDateTime(unixSec: number): string {
  if (!unixSec) return '-';
  const d = new Date(unixSec * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase());

export function hexByte(b: number): string {
  return HEX[b & 0xff];
}

/** 偏移地址十六进制，位数按文件大小自适应（8 / 16 位） */
export function hexOffset(offset: number, digits: number): string {
  return offset.toString(16).toUpperCase().padStart(digits, '0');
}

/** 解析用户输入的偏移：支持 0x 前缀 Hex、纯十进制、带 h 后缀 Hex、纯 Hex 字母 */
export function parseOffsetInput(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
  if (/^[0-9]+h$/i.test(s)) return parseInt(s.slice(0, -1), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  return null;
}

export function byteToAscii(b: number): string {
  return b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
}

/** 字节分类（用于按值着色，提升可读性） */
export function byteClass(b: number): string {
  if (b === 0) return 'z';
  if (b >= 32 && b <= 126) return 't';
  if (b >= 128) return 'h';
  return 'c';
}

/** 偏移地址列的十六进制位数 */
export function offsetDigits(fileSize: number): number {
  return fileSize > 0xffffffff ? 16 : 8;
}
