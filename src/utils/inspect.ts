/**
 * 数据检查器：对光标处开始的字节序列做多视角解读（纯函数，不依赖 React）。
 *
 * 输入最多 16 字节，输出分组解读结果；每行带 ok 标记——
 * 落在合理范围（年份 1980–2100、完整解码、字节足够）的行正常显示，
 * 不合理 / 数据不足的行由 UI 置灰。
 */

export interface InspectRow {
  label: string;
  value: string;
  /** 是否"合理"（时间戳年份在范围内 / 编码完整解出 / 数据足够）；false 时 UI 置灰 */
  ok: boolean;
  /** 颜色解读行的色块（#rrggbb / #rrggbbaa） */
  swatch?: string;
}

export interface InspectSection {
  title: string;
  rows: InspectRow[];
}

const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

function bytesAt(b: Uint8Array, i: number): number | null {
  return i < b.length ? b[i] : null;
}

/** 从 i 开始读 width 字节拼成无符号整数（大端 / 小端）；不足返回 null */
function readUint(b: Uint8Array, i: number, width: number, le: boolean): bigint | null {
  if (i + width > b.length) return null;
  let v = 0n;
  for (let j = 0; j < width; j++) {
    const byte = b[i + (le ? j : width - 1 - j)];
    v = (v << 8n) | BigInt(byte);
  }
  return v;
}

function formatInt(v: bigint, signed: boolean, width: number): string {
  if (signed) {
    const bits = BigInt(width * 8);
    const signBit = 1n << (bits - 1n);
    if (v >= signBit) v -= 1n << bits; // 转有符号补码
  }
  return v.toLocaleString('zh-CN');
}

/** 浮点：位模式 → 数值 + NaN/Infinity 标注 */
function formatFloat(b: Uint8Array, i: number, width: 4 | 8, le: boolean): string | null {
  if (i + width > b.length) return null;
  const buf = new ArrayBuffer(width);
  const view = new DataView(buf);
  for (let j = 0; j < width; j++) view.setUint8(j, b[i + j]);
  const v = width === 4 ? view.getFloat32(0, le) : view.getFloat64(0, le);
  if (Number.isNaN(v)) return 'NaN';
  if (Number.isFinite(v)) return String(parseFloat(v.toPrecision(10)));
  return v > 0 ? '+Infinity' : '-Infinity';
}

/** 时间戳 → 本地时间字符串；年份落在 1980–2100 视为合理 */
function formatTime(ms: number): { text: string; ok: boolean } | null {
  if (!Number.isFinite(ms) || ms < -62135596800000 || ms > 253370764800000) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (x: number) => String(x).padStart(2, '0');
  const text = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return { text, ok: d.getFullYear() >= MIN_YEAR && d.getFullYear() <= MAX_YEAR };
}

// FILETIME（1601-01-01 起 100ns）→ Unix 毫秒的偏移
const FILETIME_UNIX_DELTA_MS = 11644473600000;

function hex2(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

// ---------- 编码解读：fatal 解码，失败则从尾部回退找最长可解前缀 ----------

const fatalDecoders = new Map<string, TextDecoder | null>();

function getFatalDecoder(label: string): TextDecoder | null {
  let dec = fatalDecoders.get(label);
  if (dec !== undefined) return dec;
  try {
    dec = new TextDecoder(label, { fatal: true });
  } catch {
    dec = null;
  }
  fatalDecoders.set(label, dec);
  return dec;
}

interface DecodedText {
  text: string;
  /** 完整解出 = true；尾部截断 = false */
  ok: boolean;
}

function decodeStrict(b: Uint8Array, label: string): DecodedText {
  const dec = getFatalDecoder(label);
  if (!dec || b.length === 0) return { text: '—', ok: false };
  // 从整段开始，逐字节从尾部回退，找到最长可解前缀（b ≤ 16，开销可忽略）
  for (let take = b.length; take > 0; take--) {
    try {
      const s = dec.decode(b.subarray(0, take));
      const printable = Array.from(s).every(cp => cp >= ' ' && cp !== '\u007f');
      if (!printable) continue;
      return { text: s, ok: take === b.length };
    } catch {
      // 该前缀非法，继续缩短
    }
  }
  return { text: '—', ok: false };
}

function decodeAsciiStrict(b: Uint8Array): DecodedText {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x20 || c > 0x7e) break; // 遇到不可打印字符停止
    s += String.fromCharCode(c);
    i++;
  }
  return i === b.length && s.length > 0
    ? { text: s, ok: true }
    : { text: s.length ? s : '—', ok: false };
}

// ---------- 各分组 ----------

function intSection(b: Uint8Array): InspectSection {
  const rows: InspectRow[] = [];
  const push = (label: string, v: bigint | null, signed: boolean, width: number) =>
    rows.push({ label, value: v === null ? '—' : formatInt(v, signed, width), ok: v !== null });
  push('Int8', b.length > 0 ? BigInt(b[0] << 24 >> 24) : null, true, 1);
  push('UInt8', bytesAt(b, 0) === null ? null : BigInt(b[0]), false, 1);
  push('Int16 BE', readUint(b, 0, 2, false), true, 2);
  push('Int16 LE', readUint(b, 0, 2, true), true, 2);
  push('UInt16 BE', readUint(b, 0, 2, false), false, 2);
  push('UInt16 LE', readUint(b, 0, 2, true), false, 2);
  push('Int32 BE', readUint(b, 0, 4, false), true, 4);
  push('Int32 LE', readUint(b, 0, 4, true), true, 4);
  push('UInt32 BE', readUint(b, 0, 4, false), false, 4);
  push('UInt32 LE', readUint(b, 0, 4, true), false, 4);
  push('Int64 BE', readUint(b, 0, 8, false), true, 8);
  push('Int64 LE', readUint(b, 0, 8, true), true, 8);
  push('UInt64 BE', readUint(b, 0, 8, false), false, 8);
  push('UInt64 LE', readUint(b, 0, 8, true), false, 8);
  return { title: '整数', rows };
}

function floatSection(b: Uint8Array): InspectSection {
  const rows: InspectRow[] = [];
  for (const [label, width, le] of [
    ['Float32 BE', 4, false],
    ['Float32 LE', 4, true],
    ['Float64 BE', 8, false],
    ['Float64 LE', 8, true],
  ] as const) {
    const v = formatFloat(b, 0, width, le);
    rows.push({ label, value: v ?? '—', ok: v !== null });
  }
  return { title: '浮点', rows };
}

function timeSection(b: Uint8Array): InspectSection {
  const rows: InspectRow[] = [];
  const push = (label: string, ms: number | null) => {
    if (ms === null) {
      rows.push({ label, value: '—', ok: false });
      return;
    }
    const t = formatTime(ms);
    rows.push({ label, value: t?.text ?? '—', ok: t?.ok ?? false });
  };
  const secBE = readUint(b, 0, 4, false);
  const secLE = readUint(b, 0, 4, true);
  push('Unix 秒 BE', secBE === null ? null : Number(secBE) * 1000);
  push('Unix 秒 LE', secLE === null ? null : Number(secLE) * 1000);
  const msBE = readUint(b, 0, 8, false);
  const msLE = readUint(b, 0, 8, true);
  push('Unix 毫秒 BE', msBE === null ? null : Number(msBE));
  push('Unix 毫秒 LE', msLE === null ? null : Number(msLE));
  const ftBE = readUint(b, 0, 8, false);
  const ftLE = readUint(b, 0, 8, true);
  push(
    'FILETIME BE',
    ftBE === null ? null : Number(ftBE / 10000n) - FILETIME_UNIX_DELTA_MS,
  );
  push(
    'FILETIME LE',
    ftLE === null ? null : Number(ftLE / 10000n) - FILETIME_UNIX_DELTA_MS,
  );
  return { title: '时间戳', rows };
}

function encodingSection(b: Uint8Array): InspectSection {
  const ascii = decodeAsciiStrict(b);
  const utf8 = decodeStrict(b, 'utf-8');
  const gbk = decodeStrict(b, 'gbk');
  const utf16le = decodeStrict(b, 'utf-16le');
  const utf16be = decodeStrict(b, 'utf-16be');
  return {
    title: '编码',
    rows: [
      { label: 'ASCII', value: ascii.text, ok: ascii.ok },
      { label: 'UTF-8', value: utf8.text, ok: utf8.ok },
      { label: 'GBK', value: gbk.text, ok: gbk.ok },
      { label: 'UTF-16 LE', value: utf16le.text, ok: utf16le.ok },
      { label: 'UTF-16 BE', value: utf16be.text, ok: utf16be.ok },
    ],
  };
}

function numericSection(b: Uint8Array): InspectSection {
  const byte = bytesAt(b, 0);
  const rows: InspectRow[] = byte === null
    ? [{ label: '十进制', value: '—', ok: false }]
    : [
        { label: '十进制', value: String(byte), ok: true },
        { label: '十六进制', value: `0x${hex2(byte)}`, ok: true },
        { label: '八进制', value: `0o${byte.toString(8)}`, ok: true },
        { label: '二进制', value: byte.toString(2).padStart(8, '0'), ok: true },
      ];
  return { title: '数值（首字节）', rows };
}

function colorSection(b: Uint8Array): InspectSection {
  const rows: InspectRow[] = [];
  const hex = (bytes: number[]) => `#${bytes.map(hex2).join('')}`;
  // RGB / BGR：前 3 字节
  if (b.length >= 3) {
    const rgb = [b[0], b[1], b[2]];
    rows.push({ label: 'RGB', value: hex(rgb), ok: true, swatch: hex(rgb) });
    rows.push({ label: 'BGR', value: hex([b[2], b[1], b[0]]), ok: true, swatch: hex([b[2], b[1], b[0]]) });
  } else {
    rows.push({ label: 'RGB', value: '—', ok: false });
    rows.push({ label: 'BGR', value: '—', ok: false });
  }
  // RGBA / ARGB：前 4 字节
  if (b.length >= 4) {
    const rgba = [b[0], b[1], b[2], b[3]];
    const argb = [b[1], b[2], b[3], b[0]];
    rows.push({ label: 'RGBA', value: hex(rgba), ok: true, swatch: hex([rgba[0], rgba[1], rgba[2]]) });
    rows.push({ label: 'ARGB', value: hex(argb), ok: true, swatch: hex([argb[0], argb[1], argb[2]]) });
  } else {
    rows.push({ label: 'RGBA', value: '—', ok: false });
    rows.push({ label: 'ARGB', value: '—', ok: false });
  }
  return { title: '颜色', rows };
}

/** 对光标处开始的字节做全部解读；bytes 为空时各组均显示占位 */
export function inspectBytes(bytes: Uint8Array): InspectSection[] {
  return [
    intSection(bytes),
    floatSection(bytes),
    timeSection(bytes),
    numericSection(bytes),
    encodingSection(bytes),
    colorSection(bytes),
  ];
}
