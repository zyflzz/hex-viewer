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
  /** 逐字节值分布（0x00..=0xFF 出现次数），与统计扫描一次遍历同时得到 */
  histogram: number[];
}

/** 对比模式的差异区间（两边文件在 [start, start+len) 内不同，或该区间只存在于较长一侧） */
export interface DiffRange {
  start: number;
  len: number;
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

/** 对比标签页（v1.1.4）：左右并排两个文件，只读 */
export interface DiffTabInfo {
  id: string;
  kind: 'diff';
  pathA: string;
  pathB: string;
}

export type AnyTabInfo = TabInfo | DiffTabInfo;

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

// ============ 可变长度编辑（v1.1.4） ============

/** 等长替换操作的单条字节修改 */
export interface ByteChange {
  offset: number;
  oldValue: number;
  newValue: number;
}

/** 结构性原语：一次插入或删除（复合操作与坐标映射的最小单元） */
export type StructPrim =
  | { kind: 'insert'; offset: number; bytes: number[] }
  | { kind: 'delete'; offset: number; bytes: number[] };

/** 编辑历史操作（等长替换 / 插入 / 删除 / 复合） */
export type EditOp =
  | {
      id: string;
      label: string;
      time: number;
      kind: 'replace';
      changes: ByteChange[];
    }
  | {
      id: string;
      label: string;
      time: number;
      kind: 'insert';
      offset: number;
      bytes: number[];
    }
  | {
      id: string;
      label: string;
      time: number;
      kind: 'delete';
      offset: number;
      /** 被删除的内容（撤销 / 重做时用于原样恢复） */
      bytes: number[];
    }
  | {
      id: string;
      label: string;
      time: number;
      kind: 'composite';
      /** 子操作序列（版本恢复 / 保存点回退等场景的复合变更） */
      ops: EditOp[];
    };

/** 历史快照（autosave / 版本记录用） */
export interface EditSnapshot {
  ops: EditOp[];
  pos: number;
  diskOps: number;
}

/** 命令面板条目（App 全局命令 + FileTab 文件命令两层注册表） */
export interface CommandDef {
  id: string;
  label: string;
  category: string;
  /** 快捷键提示（可选，仅展示） */
  shortcut?: string;
}

/** 崩溃恢复检测到的自动保存信息 */
export interface AutosaveInfo {
  time: number;
  payload: {
    ops: EditOp[];
    pos: number;
    diskOps: number;
    cursor: number | null;
    selection: Selection | null;
  };
}
