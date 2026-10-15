import { byteToAscii, hexByte, hexOffset, offsetDigits } from './format';

export interface AiContextParams {
  /** 实际字节数据（可能已按上下文上限截断） */
  bytes: Uint8Array;
  /** bytes[0] 的绝对偏移 */
  start: number;
  /** 截断前的完整区间长度 */
  fullLength: number;
  /** 是否因超过上限被截断 */
  truncated: boolean;
  /** 区间标题（「选中范围」/「光标附近 N 字节」） */
  title: string;
  /** 当前光标绝对偏移（可为空） */
  cursorOffset: number | null;
  /** 光标处字节值（可为空） */
  cursorByte: number | null;
  /** 文件大小（决定偏移显示位数） */
  fileSize: number;
}

/** 尝试整段严格解码：失败返回 null；控制字符（除换行/制表）替换为 ·，避免污染提示词 */
function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (!text) return null;
    return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·');
  } catch {
    return null;
  }
}

/**
 * 构造发给模型的结构化数据上下文：
 * 区间信息 / HEX（每行 16 字节带偏移）/ ASCII / UTF-8 与 GBK 解码结果 / 光标字节。
 * 不注入文件路径与文件名，避免泄露隐私、避免模型靠文件名猜测。
 */
export function buildAiContext(p: AiContextParams): string {
  const digits = offsetDigits(p.fileSize);
  const { bytes } = p;
  const lines: string[] = [];

  lines.push(`[${p.title}]`);
  lines.push(
    `偏移: 0x${hexOffset(p.start, digits)} – 0x${hexOffset(p.start + p.fullLength - 1, digits)}`,
  );
  lines.push(`长度: ${p.fullLength} 字节`);
  if (p.truncated) lines.push(`截断: 已截断，仅显示前 ${bytes.length} 字节`);

  // HEX：每行 16 字节，带偏移前缀，方便模型数位置
  lines.push('', '[HEX]');
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row, hexByte).join(' ');
    lines.push(`${hexOffset(p.start + i, digits)}  ${hex}`);
  }

  // ASCII：不可打印字符显示为 .（与 HEX 行对齐，每行 16 字符）
  lines.push('', '[ASCII]');
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    let s = '';
    for (let j = 0; j < row.length; j++) s += byteToAscii(row[j]);
    lines.push(s);
  }

  // 文本解码：能整段严格解码才展示，否则标注不可解码（不采样、不跳读，避免误导）
  lines.push('', '[UTF-8]');
  lines.push(tryDecode(bytes, 'utf-8') ?? '无法完整解码');
  lines.push('', '[GBK]');
  lines.push(tryDecode(bytes, 'gbk') ?? '无法完整解码');

  if (p.cursorOffset !== null && p.cursorByte !== null) {
    lines.push('', '[光标]');
    lines.push(
      `偏移 0x${hexOffset(p.cursorOffset, digits)}: 十六进制 ${hexByte(p.cursorByte)}, 十进制 ${p.cursorByte}, 二进制 ${p.cursorByte
        .toString(2)
        .padStart(8, '0')}`,
    );
  }

  return lines.join('\n');
}
