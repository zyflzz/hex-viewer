/**
 * AI 模板输出解析与字段校验（v1.1.5）：
 * 解析层：直接 JSON.parse → ```json 代码块提取 → 失败返回原始输出供手动修正。
 * 校验层：字段名 / 偏移边界 / 长度合理范围 / 类型枚举白名单。
 * 纯函数，不依赖 React。
 */
import type { TemplateField, TemplateFieldType } from '../types';
import { hexByte } from './format';

/** 生成模板专用系统提示词（与对话 system prompt 隔离，避免互相污染） */
export const TEMPLATE_SYSTEM_PROMPT = `你是一个十六进制编辑器中的二进制结构分析助手。用户会提供一段字节序列（HEX + ASCII + 可能的文本解码）和格式描述。

你的职责：根据用户的描述和字节内容，把这段数据拆解为结构化字段列表。

输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要输出任何解释文字、不要使用 markdown 代码块
- JSON 格式固定为：
{ "name": "模板名称", "description": "模板说明", "fields": [{ "name": "字段名", "offset": 0, "length": 4, "type": "uint32", "description": "字段说明" }] }
- offset 为相对给定数据起始位置（0）的字节偏移；length 为字节长度
- type 只能取以下值之一：uint8/uint16/uint32/uint64/int8/int16/int32/int64/float/double/string/timestamp/color/bytes
  （timestamp 表示 Unix 时间戳，4 字节按秒、8 字节按毫秒；color 表示 RGB/RGBA 颜色）
- 字段之间允许有间隙（未覆盖的字节不强制归属字段），字段不得互相重叠
- 用户未提到的部分不要臆测编造；不确定时减少字段并如实说明`;

const FIELD_TYPES: readonly TemplateFieldType[] = [
  'uint8', 'uint16', 'uint32', 'uint64',
  'int8', 'int16', 'int32', 'int64',
  'float', 'double', 'string', 'timestamp', 'color', 'bytes',
];

export interface ParsedTemplate {
  name: string;
  description: string;
  fields: TemplateField[];
}

export interface ParseResult {
  ok: boolean;
  template?: ParsedTemplate;
  /** 解析失败时的原始输出（供用户手动修正） */
  raw: string;
  error?: string;
}

/** 从任意文本中尽力提取 JSON 对象：直接 parse → ```json 块 → 首个 {...} 平衡块 */
function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }
  // 首个 { 起做括号配平（容忍字符串内的花括号）
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === '"') {
        inStr = !inStr;
      } else if (!inStr) {
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(trimmed.slice(start, i + 1));
            } catch {
              return undefined;
            }
          }
        }
      }
    }
  }
  return undefined;
}

/** 单字段校验与规范化（越界钳制 + 类型白名单），返回 null 表示丢弃该字段 */
function normalizeField(v: unknown, dataLen: number): TemplateField | null {
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Partial<TemplateField>;
  const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null;
  const offset = Number(f.offset);
  const length = Number(f.length);
  if (name === null || !Number.isFinite(offset) || !Number.isFinite(length)) return null;
  const off = Math.max(0, Math.floor(offset));
  const len = Math.floor(length);
  if (len < 1 || off >= dataLen) return null; // 起点越界：丢弃
  const type: TemplateFieldType = FIELD_TYPES.includes(f.type as TemplateFieldType)
    ? (f.type as TemplateFieldType)
    : 'bytes';
  return {
    name,
    offset: off,
    length: Math.min(len, dataLen - off), // 长度截到数据末尾
    type,
    description: typeof f.description === 'string' ? f.description : undefined,
  };
}

/** 解析 AI 输出为字段列表（含边界校验）；失败时返回原始输出与错误信息 */
export function parseTemplateOutput(raw: string, dataLen: number): ParseResult {
  const obj = extractJson(raw);
  if (obj === undefined || typeof obj !== 'object') {
    return {
      ok: false,
      raw,
      error: 'AI 输出不是有效的 JSON，请在下方手动修正后重新解析',
    };
  }
  const t = obj as { name?: unknown; description?: unknown; fields?: unknown };
  if (!Array.isArray(t.fields)) {
    return { ok: false, raw, error: 'JSON 中缺少 fields 数组，请修正后重新解析' };
  }
  const fields: TemplateField[] = [];
  const seen: Array<[number, number]> = [];
  for (const item of t.fields) {
    const f = normalizeField(item, dataLen);
    if (!f) continue;
    // 重叠检测：与已有字段重叠时保留先出现的（提示用户可手动调整）
    const overlap = seen.some(([s, e]) => f.offset <= e && f.offset + f.length - 1 >= s);
    if (overlap) continue;
    seen.push([f.offset, f.offset + f.length - 1]);
    fields.push(f);
  }
  if (fields.length === 0) {
    return { ok: false, raw, error: '未解析到有效字段（偏移越界或字段为空），请修正后重新解析' };
  }
  return {
    ok: true,
    raw,
    template: {
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : '未命名模板',
      description: typeof t.description === 'string' ? t.description : '',
      fields,
    },
  };
}

/** 手动修正路径：用户编辑的 JSON 文本 → 解析 */
export function parseManualJson(text: string, dataLen: number): ParseResult {
  return parseTemplateOutput(text, dataLen);
}

function readLE(bytes: Uint8Array, off: number, len: number): bigint {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i] ?? 0);
  return v;
}

function printable(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += b >= 32 && b <= 126 ? String.fromCharCode(b) : b === 0 ? '' : '·';
  }
  return s || '—';
}

/** 字段当前值预览（小端为主；时间戳/颜色按长度推断），异常返回 '—' */
export function fieldPreview(bytes: Uint8Array, f: TemplateField): string {
  const off = f.offset;
  const len = f.length;
  if (off + len > bytes.length) return '—';
  try {
    switch (f.type) {
      case 'uint8':
        return String(bytes[off]);
      case 'uint16':
      case 'uint32':
      case 'uint64': {
        const n = readLE(bytes, off, len);
        return `${n.toString()} (0x${n.toString(16).toUpperCase()})`;
      }
      case 'int8':
      case 'int16':
      case 'int32':
      case 'int64': {
        const bits = BigInt(len * 8);
        let v = readLE(bytes, off, len);
        if (v >= 1n << (bits - 1n)) v -= 1n << bits;
        return v.toString();
      }
      case 'float': {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 4);
        return String(dv.getFloat32(0, true));
      }
      case 'double': {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
        return String(dv.getFloat64(0, true));
      }
      case 'string': {
        try {
          return JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(off, off + len)));
        } catch {
          return JSON.stringify(printable(bytes.subarray(off, off + len)));
        }
      }
      case 'timestamp': {
        const n = Number(readLE(bytes, off, Math.min(len, 8)));
        if (!Number.isFinite(n) || n <= 0) return '—';
        const ms = len >= 8 ? n : n * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) || d.getFullYear() < 1980 || d.getFullYear() > 2100
          ? `${n}（非合理时间）`
          : `${n} → ${d.toLocaleString('zh-CN', { hour12: false })}`;
      }
      case 'color': {
        const hex = Array.from(bytes.subarray(off, off + Math.min(len, 4)), hexByte).join('');
        return `#${hex}`;
      }
      default:
        return printable(bytes.subarray(off, off + len));
    }
  } catch {
    return '—';
  }
}
