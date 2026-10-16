/**
 * Hex 字符串解析与文本编码工具。
 *
 * parseHexPattern 与后端搜索的 Hex 模式规则保持一致（lib.rs parse_pattern）：
 * 忽略空格 / 冒号 / 逗号 / 短横线 / 下划线 / 点，支持 0x 前缀，长度必须为偶数。
 * 前端版本供"替换内容校验"与"粘贴 Hex"复用。
 */

const SEPARATORS = new Set([' ', ':', ',', '-', '_', '.']);

/** 解析 Hex 字符串为字节序列；非法（奇数长度 / 非 Hex 字符 / 空）返回 null */
export function parseHexPattern(input: string): Uint8Array | null {
  let s = '';
  for (const ch of input) if (!SEPARATORS.has(ch)) s += ch;
  if (s.length >= 2 && (s.startsWith('0x') || s.startsWith('0X'))) s = s.slice(2);
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------- 查找替换共享校验（App 工具栏展示与 FileTab 替换执行共用） ----------

/** 搜索模式 */
export type ReplaceMode = 'text' | 'hex';

/** 搜索内容字节长度（文本 = UTF-8 字节数，Hex = 解析结果长度；非法 -1，空 0） */
export function computeSearchLen(mode: ReplaceMode, searchText: string): number {
  if (mode === 'hex') {
    const b = parseHexPattern(searchText);
    return b ? b.length : -1;
  }
  return searchText.length > 0 ? encodeTextToBytes(searchText, 'utf-8').length : 0;
}

export interface ReplaceValidation {
  /** 替换内容编码后的字节（校验通过时非 null） */
  replaceBytes: Uint8Array | null;
  /** 是否可执行替换（等长且格式合法） */
  ok: boolean;
  /** 校验失败原因（按钮禁用时展示），成功为 null */
  hint: string | null;
  /** 搜索内容字节长度（与 computeSearchLen 一致） */
  searchLen: number;
}

/**
 * 替换内容校验：与搜索内容等长（文本按 UTF-8 字节数、Hex 按解析字节数）才允许执行。
 * 纯函数：App（工具栏提示）与 FileTab（替换方法）共用同一套规则。
 */
export function validateReplace(
  mode: ReplaceMode,
  searchText: string,
  replaceText: string,
): ReplaceValidation {
  const searchLen = computeSearchLen(mode, searchText);
  if (searchLen <= 0) {
    const hint =
      mode === 'hex' && searchText.trim() !== '' && !parseHexPattern(searchText)
        ? '搜索内容不是有效的 Hex 字符串'
        : null;
    return { replaceBytes: null, ok: false, hint, searchLen };
  }
  if (replaceText.trim() === '') {
    return { replaceBytes: null, ok: false, hint: '待输入替换内容', searchLen };
  }
  const bytes =
    mode === 'hex' ? parseHexPattern(replaceText) : encodeTextToBytes(replaceText, 'utf-8');
  if (!bytes || bytes.length === 0) {
    return {
      replaceBytes: null,
      ok: false,
      hint: mode === 'hex' ? '替换内容不是有效的 Hex 字符串' : '替换内容为空',
      searchLen,
    };
  }
  if (bytes.length !== searchLen) {
    return {
      replaceBytes: null,
      ok: false,
      hint: `替换内容长度必须与搜索内容一致（${searchLen} 字节）`,
      searchLen,
    };
  }
  return { replaceBytes: bytes, ok: true, hint: null, searchLen };
}

// ---------- 文本编码（粘贴文本用） ----------

const utf8Encoder = new TextEncoder();

/**
 * GBK 编码器：浏览器只提供 GBK 的 TextDecoder（解码），没有编码器。
 * 这里用解码器反向构建"字符 → 字节对"映射表（首次调用时懒加载，
 * 约 32K 次双字节解码，一次性毫秒级开销，之后复用）。
 * 0x00–0x7F 单字节字符直接映射，未收录字符返回 null。
 */
let gbkEncodeMap: Map<string, [number, number]> | null | undefined;

function getGbkEncodeMap(): Map<string, [number, number]> | null {
  if (gbkEncodeMap !== undefined) return gbkEncodeMap;
  gbkEncodeMap = null;
  let dec: TextDecoder;
  try {
    dec = new TextDecoder('gbk');
  } catch {
    return null;
  }
  const map = new Map<string, [number, number]>();
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const s = dec.decode(new Uint8Array([lead, trail]));
      if (s.length === 1 && s !== '\uFFFD' && !map.has(s)) map.set(s, [lead, trail]);
    }
  }
  gbkEncodeMap = map;
  return map;
}

/** 按指定编码把文本编码为字节序列；GBK 不可用或含无法编码的字符时逐字符降级为 '?' */
export function encodeTextToBytes(text: string, encoding: string): Uint8Array {
  switch (encoding) {
    case 'utf-8':
      return utf8Encoder.encode(text);
    case 'utf-16le':
    case 'utf-16be': {
      const le = encoding === 'utf-16le';
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const u = text.charCodeAt(i);
        if (le) out.push(u & 0xff, u >> 8);
        else out.push(u >> 8, u & 0xff);
      }
      return new Uint8Array(out);
    }
    case 'gbk': {
      const map = getGbkEncodeMap();
      if (!map) {
        // 无 GBK 解码器（环境异常）：退化为 ASCII
        return encodeTextToBytes(text, 'ascii');
      }
      const out: number[] = [];
      for (const ch of text) {
        if (ch.charCodeAt(0) < 0x80) out.push(ch.charCodeAt(0));
        else {
          const pair = map.get(ch);
          if (pair) out.push(pair[0], pair[1]);
          else out.push(0x3f); // '?'：GBK 未收录该字符
        }
      }
      return new Uint8Array(out);
    }
    default: {
      // ASCII：非 ASCII 字符替换为 '?'
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[i] = c >= 0x20 && c <= 0x7e ? c : 0x3f;
      }
      return out;
    }
  }
}
