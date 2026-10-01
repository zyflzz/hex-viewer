/** 与 Rust 后端约定的数据结构 */

export interface FileMeta {
  path: string;
  name: string;
  size: number;
  modified: number; // unix 秒
  created: number; // unix 秒
  extension: string;
  kind: string;
  is_readonly: boolean;
}

export interface SearchHit {
  offset: number;
  context: number[]; // 命中位置开始的上下文字节（最多 32 个）
}

export interface SearchProgress {
  searched: number;
  total: number;
  hits: number;
}

export interface AnalysisProgress {
  searched: number;
  total: number;
}

export interface FileStats {
  total: number;
  printable: number;
  control: number;
  high: number;
  zero: number;
  line_breaks: number;
}

export interface PerfInfo {
  memory: number; // 字节
  cpu: number; // 百分比
}

export type ThemeName = 'dark' | 'light' | 'contrast';

export type BytesPerRow = 8 | 16 | 32;

/** 右侧栏文本编码 */
export type TextEncoding = 'ascii' | 'utf-8' | 'gbk' | 'utf-16le' | 'utf-16be';

export interface DisplayConfig {
  bytesPerRow: BytesPerRow;
  fontSize: number;
  theme: ThemeName;
  showAscii: boolean;
  encoding: TextEncoding;
}

/** 字节级选择（含首尾） */
export interface Selection {
  start: number;
  end: number;
}

/** 书签（点，start === end）或标记（区间，start < end），按文件路径持久化 */
export interface Bookmark {
  id: string;
  /** 起始偏移；点书签时 start === end */
  start: number;
  /** 结束偏移；点书签时 start === end */
  end: number;
  /** 用户命名，可为空；空名字在列表中显示偏移值 */
  name: string;
  /** 预设调色板颜色（#rrggbb） */
  color: string;
  createdAt: number;
}
