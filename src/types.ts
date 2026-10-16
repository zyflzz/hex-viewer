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
  tabId: string;
  searched: number;
  total: number;
  hits: number;
}

export interface AnalysisProgress {
  tabId: string;
  searched: number;
  total: number;
}

/** 字符串提取结果（分析选项卡） */
export type StringEncoding = 'ascii' | 'utf-8' | 'utf-16le' | 'utf-16be';

export interface StringHit {
  offset: number;
  encoding: StringEncoding;
  /** 字节长度 */
  length: number;
  /** 解码文本（超长已截断为 160 字符 + 省略号） */
  text: string;
}

export interface StringsResult {
  hits: StringHit[];
  /** 命中总数（可能多于返回条数） */
  total: number;
}

/** 校验和计算结果（分析选项卡，均为小写十六进制） */
export interface Checksums {
  len: number;
  crc32: string;
  crc16: string;
  adler32: string;
  md5: string;
  sha1: string;
  sha256: string;
  xor8: string;
  sum8: string;
}

export interface FileStats {
  total: number;
  printable: number;
  control: number;
  high: number;
  zero: number;
  lineBreaks: number;
}

export interface PerfInfo {
  memory: number; // 字节
  cpu: number; // 百分比
}

export type ThemeName = 'dark' | 'light' | 'contrast';

/** 侧栏选项卡 */
export type SidebarTab =
  | 'info'
  | 'bookmarks'
  | 'search'
  | 'edit'
  | 'versions'
  | 'ai'
  | 'analyze';

/** 编辑输入模式：对话框（Ctrl+E）/ 直接（双击字节原地编辑） */
export type EditMode = 'dialog' | 'direct';

/** 历史版本记录模式：保存时自动记录 / 手动按钮记录 */
export type VersionMode = 'auto' | 'manual';

export type BytesPerRow = 8 | 16 | 32;

/** 右侧栏文本编码 */
export type TextEncoding = 'ascii' | 'utf-8' | 'gbk' | 'utf-16le' | 'utf-16be';

export interface DisplayConfig {
  bytesPerRow: BytesPerRow;
  fontSize: number;
  theme: ThemeName;
  showAscii: boolean;
  encoding: TextEncoding;
  /** 编辑输入模式（全局偏好，与文件无关） */
  editMode: EditMode;
  /** 保存前二次确认 */
  confirmSave: boolean;
  /** 历史版本记录模式（保存时自动 / 手动） */
  versionMode: VersionMode;
  /** HEX 列字节分组（1 = 无分组） */
  byteGrouping: 1 | 2 | 4 | 8;
  /** 光标所在行高亮 */
  rowHighlight: boolean;
  /** 光标所在列高亮 */
  colHighlight: boolean;
}

/** 标签页对外上报的状态（App 汇总用于工具栏 / 标签栏展示） */
export interface FileTabStatus {
  name: string;
  /** 未保存编辑字节数 */
  editCount: number;
  searching: boolean;
  searchPercent: number;
  hitCount: number;
  /** 历史版本预览中（只读） */
  previewing: boolean;
}

/** 标签页信息（App 维护） */
export interface TabInfo {
  id: string;
  path: string;
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
