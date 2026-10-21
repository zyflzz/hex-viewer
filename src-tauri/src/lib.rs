// 大文件优化版后端：
// - mmap 内存映射，按需返回字节切片（前端虚拟滚动按需请求）
// - 多标签页：AppState 按标签页 ID 维护文件映射，各标签页互不干扰
// - 高速搜索（memchr 加速 + 进度事件 + 可取消）、字符串提取、校验和计算
// - 后台全文件统计分析（字符数等，带进度）
// - 进程内存 / CPU 性能数据
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use memmap2::Mmap;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Emitter, State};

mod autosave;
mod edit;
mod versions;

use edit::PieceTable;

/// 单次 read_chunk 返回的最大字节数
const MAX_CHUNK_LEN: u64 = 8 * 1024 * 1024;
/// 搜索 / 统计扫描的分块大小（同时是进度事件与取消检查的粒度）
const SCAN_BLOCK: usize = 32 * 1024 * 1024;
/// 搜索模式的最大长度
const MAX_PATTERN_LEN: usize = 4096;
/// 字符串提取的分块大小（取消检查粒度）
const STRINGS_BLOCK: usize = 8 * 1024 * 1024;
/// 字符串提取结果上限（超出只计数，前端提示"还有 N 条未显示"）
const MAX_STRING_HITS: usize = 5000;
/// 单条字符串结果的文本截断长度（字符数）
const MAX_TEXT_CHARS: usize = 160;
/// 校验和计算的最大区间长度
const MAX_CHECKSUM_LEN: u64 = 4 * 1024 * 1024;

/// 已打开的文件（mmap 句柄 + 元数据），在 AppState 中以 Arc 共享
pub struct OpenedFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
    created: u64,
    extension: String,
    kind: String,
    is_readonly: bool,
    mmap: Option<Mmap>,
}

#[derive(Serialize)]
pub struct FileMeta {
    path: String,
    name: String,
    size: u64,
    modified: u64,
    created: u64,
    extension: String,
    kind: String,
    is_readonly: bool,
}

/// 保存结果（v1.1.5）：meta + 保存后校验结论
/// verified = 所有已执行的校验均通过（关闭校验时恒为 true）
/// hash = 写入时同步累计的 SHA-256（关闭校验时为 None）
/// verify_stage = 校验失败发生的阶段（"写入临时文件" / "替换原文件"），成功时为 None
#[derive(Serialize)]
pub struct SaveResult {
    pub meta: FileMeta,
    pub verified: bool,
    pub hash: Option<String>,
    pub verify_stage: Option<String>,
}

impl OpenedFile {
    /// 当前文件路径（版本目录名按路径散列）
    pub(crate) fn path_string(&self) -> &str {
        &self.path
    }

    /// mmap 数据切片（空文件为 None）
    pub(crate) fn mmap_bytes(&self) -> Option<&[u8]> {
        self.mmap.as_ref().map(|m| &m[..])
    }
}

impl From<&OpenedFile> for FileMeta {
    fn from(f: &OpenedFile) -> Self {
        FileMeta {
            path: f.path.clone(),
            name: f.name.clone(),
            size: f.size,
            modified: f.modified,
            created: f.created,
            extension: f.extension.clone(),
            kind: f.kind.clone(),
            is_readonly: f.is_readonly,
        }
    }
}

/// 单个标签页的后端状态：文件句柄 + piece 表 + 三类后台扫描的代数（用于取消/作废）
#[derive(Clone)]
pub struct TabState {
    pub(crate) file: Arc<OpenedFile>,
    /// 可变长度编辑状态（打开/保存后为"干净的"单基线 piece）
    pub(crate) edits: Arc<Mutex<PieceTable>>,
    pub(crate) search_gen: Arc<AtomicU64>,
    pub(crate) analysis_gen: Arc<AtomicU64>,
    pub(crate) strings_gen: Arc<AtomicU64>,
}

impl TabState {
    fn new(file: Arc<OpenedFile>) -> Self {
        let edits = Arc::new(Mutex::new(PieceTable::new(file.size)));
        TabState {
            file,
            edits,
            search_gen: Arc::new(AtomicU64::new(0)),
            analysis_gen: Arc::new(AtomicU64::new(0)),
            strings_gen: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 保存成功后重建：保留扫描代数，piece 表重置为干净基线
    fn rebuild(file: Arc<OpenedFile>, search_gen: Arc<AtomicU64>, analysis_gen: Arc<AtomicU64>, strings_gen: Arc<AtomicU64>) -> Self {
        let edits = Arc::new(Mutex::new(PieceTable::new(file.size)));
        TabState { file, edits, search_gen, analysis_gen, strings_gen }
    }
}

pub struct AppState {
    /// 标签页 ID → 文件状态（多标签页互不干扰）
    tabs: Mutex<HashMap<String, TabState>>,
    sys: Mutex<System>,
    /// 版本存储全局锁：防止并发记录/删除/清理导致 meta.json 竞写
    versions_lock: Arc<Mutex<()>>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            tabs: Mutex::new(HashMap::new()),
            sys: Mutex::new(System::new()),
            versions_lock: Arc::new(Mutex::new(())),
        }
    }

    /// 取标签页状态（不存在 = 尚未打开）
    pub(crate) fn get_tab(&self, tab_id: &str) -> Option<TabState> {
        self.tabs.lock().unwrap().get(tab_id).cloned()
    }

    pub(crate) fn insert_tab(&self, tab_id: String, st: TabState) {
        self.tabs.lock().unwrap().insert(tab_id, st);
    }

    /// 移除标签页并使其仍在运行的后台扫描尽快中止
    pub(crate) fn remove_tab(&self, tab_id: &str) -> Option<TabState> {
        let removed = self.tabs.lock().unwrap().remove(tab_id);
        if let Some(t) = &removed {
            t.search_gen.fetch_add(1, Ordering::SeqCst);
            t.analysis_gen.fetch_add(1, Ordering::SeqCst);
            t.strings_gen.fetch_add(1, Ordering::SeqCst);
        }
        removed
    }
}

fn unix_secs(t: std::io::Result<SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 通过魔数 + 扩展名识别文件类型
fn detect_kind(d: &[u8], ext: &str) -> String {
    if d.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "PNG 图像".into();
    }
    if d.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "JPEG 图像".into();
    }
    if d.starts_with(b"GIF8") {
        return "GIF 图像".into();
    }
    if d.starts_with(&[0x42, 0x4D]) {
        return "BMP 图像".into();
    }
    if d.starts_with(b"%PDF") {
        return "PDF 文档".into();
    }
    if d.starts_with(b"PK\x03\x04") {
        return match ext {
            "docx" => "Word 文档 (ZIP)",
            "xlsx" | "csvx" => "Excel 表格 (ZIP)",
            "pptx" => "PPT 演示 (ZIP)",
            "jar" => "Java 归档 (ZIP)",
            "apk" => "Android 应用 (ZIP)",
            "epub" => "电子书 (ZIP)",
            _ => "ZIP 压缩包",
        }
        .into();
    }
    if d.starts_with(b"Rar!\x1A\x07") {
        return "RAR 压缩包".into();
    }
    if d.starts_with(b"7z\xBC\xAF\x27\x1C") {
        return "7-Zip 压缩包".into();
    }
    if d.starts_with(&[0x1F, 0x8B]) {
        return "GZip 压缩".into();
    }
    if d.starts_with(b"\xFD7zXZ") {
        return "XZ 压缩包".into();
    }
    if d.starts_with(&[0x7F, b'E', b'L', b'F']) {
        return "ELF 可执行文件".into();
    }
    if d.starts_with(b"MZ") {
        return "Windows 可执行文件 (PE)".into();
    }
    if d.starts_with(b"SQLite format 3") {
        return "SQLite 数据库".into();
    }
    if d.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]) {
        return "Java 类文件".into();
    }
    if d.starts_with(&[0x00, b'a', b's', b'm']) {
        return "WebAssembly 模块".into();
    }
    if d.starts_with(b"OggS") {
        return "OGG 音频".into();
    }
    if d.len() >= 12 && &d[0..4] == b"RIFF" {
        return "RIFF 媒体 (WAV/AVI)".into();
    }
    if d.len() >= 12 && &d[4..8] == b"ftyp" {
        return "MP4 视频".into();
    }
    // 文本启发式：前 512 字节全部是可打印/常见空白/UTF-8 高位则视为文本
    let n = d.len().min(512);
    if n > 0
        && d[..n]
            .iter()
            .all(|&b| b == 9 || b == 10 || b == 13 || (32..=126).contains(&b) || b >= 128)
    {
        return match ext {
            "txt" | "log" => "文本文件".into(),
            "md" | "markdown" => "Markdown 文本".into(),
            "json" => "JSON 文本".into(),
            "xml" | "html" | "htm" | "svg" => "标记文本 (XML/HTML)".into(),
            "csv" | "tsv" => "表格文本 (CSV)".into(),
            "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "c" | "h" | "cpp" | "java" | "go"
            | "css" | "scss" | "sh" | "bat" => "源代码文本".into(),
            _ => "文本内容".into(),
        };
    }
    match ext {
        "bin" => "二进制数据".into(),
        "dat" => "数据文件".into(),
        "hex" => "Hex 数据".into(),
        "dll" => "动态链接库".into(),
        "exe" => "可执行文件".into(),
        "so" | "dylib" => "共享库".into(),
        "iso" | "img" | "vhd" => "磁盘镜像".into(),
        "mp3" | "flac" | "wav" => "音频文件".into(),
        "mp4" | "mkv" | "avi" | "mov" => "视频文件".into(),
        "ttf" | "otf" | "woff" | "woff2" => "字体文件".into(),
        _ => "未知类型（二进制）".into(),
    }
}

/// 打开并映射文件，构造 OpenedFile（open_file / save_file 共用）
fn open_mapped(path: &str) -> Result<Arc<OpenedFile>, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let md = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息: {}", e))?;
    let size = md.len();
    // 空文件无法建立映射
    let mmap = if size > 0 {
        Some(unsafe { Mmap::map(&file).map_err(|e| format!("无法映射文件: {}", e))? })
    } else {
        None
    };
    let name = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());
    let extension = Path::new(path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let modified = unix_secs(md.modified());
    let created = unix_secs(md.created());
    let is_readonly = md.permissions().readonly();
    let kind = match &mmap {
        Some(m) => detect_kind(&m[..m.len().min(64)], &extension),
        None => "空文件".into(),
    };
    Ok(Arc::new(OpenedFile {
        path: path.to_string(),
        name,
        size,
        modified,
        created,
        extension,
        kind,
        is_readonly,
        mmap,
    }))
}

/// 打开文件（标签页）：只建立 mmap 映射并返回元数据，不把文件读入内存。
/// 同一标签页重复打开（如保存后重开）会替换旧句柄并中止旧扫描。
#[tauri::command]
fn open_file(path: String, tab_id: String, state: State<AppState>) -> Result<FileMeta, String> {
    if let Some(old) = state.get_tab(&tab_id) {
        // 替换句柄前先让旧扫描检测到代数变化而中止
        old.search_gen.fetch_add(1, Ordering::SeqCst);
        old.analysis_gen.fetch_add(1, Ordering::SeqCst);
        old.strings_gen.fetch_add(1, Ordering::SeqCst);
    }
    let opened = open_mapped(&path)?;
    let meta = FileMeta::from(opened.as_ref());
    state.insert_tab(tab_id, TabState::new(opened));
    Ok(meta)
}

/// 关闭标签页：移除映射并释放 mmap（同时中止该页仍在运行的扫描）
#[tauri::command]
fn close_tab(tab_id: String, state: State<AppState>) {
    state.remove_tab(&tab_id);
}

/// 读取任意路径的文件元信息（插入对话框"从文件插入"预检，不占用标签页句柄）
#[tauri::command]
fn get_file_meta(path: String) -> Result<FileMeta, String> {
    let md = fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if !md.is_file() {
        return Err("不是常规文件".into());
    }
    let name = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());
    let extension = Path::new(&path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Ok(FileMeta {
        path,
        name,
        size: md.len(),
        modified: unix_secs(md.modified()),
        created: unix_secs(md.created()),
        extension,
        kind: String::new(),
        is_readonly: md.permissions().readonly(),
    })
}

/// 读取任意路径的文件内容（插入对话框"从文件插入"；超 max_len 拒绝，防误读超大文件）
#[tauri::command]
fn read_file_bytes(path: String, max_len: u64) -> Result<Vec<u8>, String> {
    let md = fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if !md.is_file() {
        return Err("不是常规文件".into());
    }
    if md.len() > max_len {
        return Err(format!("文件过大（{} 字节），上限 {} 字节", md.len(), max_len));
    }
    fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 查找某字节值在磁盘内容中首次出现的位置（分析选项卡直方图点击跳转）
#[tauri::command]
async fn find_first_byte(
    tab_id: String,
    value: u8,
    state: State<'_, AppState>,
) -> Result<Option<u64>, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let file = tab.file;
    let handle = tauri::async_runtime::spawn_blocking(move || {
        Ok(file
            .mmap
            .as_ref()
            .and_then(|m| m.iter().position(|&b| b == value).map(|p| p as u64)))
    });
    match handle.await {
        Ok(r) => r,
        Err(e) => Err(format!("查找任务失败: {}", e)),
    }
}

/// 按需读取字节切片（返回原始二进制，避免 JSON 序列化开销）。
/// v1.1.4 起 offset 为虚拟偏移：跨 piece 拼接（基线 + 插入内容 - 删除区间）。
#[tauri::command]
fn read_chunk(
    tab_id: String,
    offset: u64,
    length: u64,
    state: State<AppState>,
) -> Result<tauri::ipc::Response, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let file = tab.file;
    let base: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
    let pt = tab.edits.lock().unwrap();
    let vsize = pt.virtual_size();
    if vsize == 0 || offset >= vsize {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let len = length.min(vsize - offset).min(MAX_CHUNK_LEN);
    let bytes = pt.read(offset, len, base);
    Ok(tauri::ipc::Response::new(bytes))
}

/// 在虚拟偏移处插入字节（可变长度编辑）。返回新的虚拟大小。
#[tauri::command]
fn insert_bytes(
    tab_id: String,
    offset: u64,
    bytes: Vec<u8>,
    state: State<AppState>,
) -> Result<u64, String> {
    if bytes.is_empty() {
        return Err("插入内容为空".into());
    }
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let mut pt = tab.edits.lock().unwrap();
    if offset > pt.virtual_size() {
        return Err(format!("插入位置超出文件末尾（当前共 {} 字节）", pt.virtual_size()));
    }
    pt.insert(offset, &bytes);
    Ok(pt.virtual_size())
}

/// 删除虚拟区间 [offset, offset+len)。返回新的虚拟大小。
#[tauri::command]
fn delete_range(
    tab_id: String,
    offset: u64,
    len: u64,
    state: State<AppState>,
) -> Result<u64, String> {
    if len == 0 {
        return Err("删除长度不能为 0".into());
    }
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let mut pt = tab.edits.lock().unwrap();
    let vsize = pt.virtual_size();
    if offset >= vsize || offset + len > vsize {
        return Err(format!("删除区间超出文件末尾（当前共 {} 字节）", vsize));
    }
    pt.delete(offset, len);
    Ok(pt.virtual_size())
}

/// 当前虚拟大小（= 基线 + 插入 - 删除）
#[tauri::command]
fn get_virtual_size(tab_id: String, state: State<AppState>) -> Result<u64, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let vsize = tab.edits.lock().unwrap().virtual_size();
    Ok(vsize)
}

/// 前端覆盖层的单条字节修改
#[derive(serde::Deserialize)]
pub struct ByteChange {
    pub offset: u64,
    pub value: u8,
}

/// 保存的核心流程（阻塞线程内执行）：
/// 1. 合并同一偏移的多次修改（BTreeMap 自动按偏移有序），偏移按虚拟大小校验
/// 2. 按 piece 表顺序输出（基线 + 追加缓冲），同时应用覆盖层补丁，
///    写出时同步累计 SHA-256（零额外 I/O）→ 写同目录临时文件（sync 落盘）
/// 3. 校验层一：重新读取临时文件计算 SHA-256，与写入时哈希比对（确认数据正确到达临时文件）
/// 4. 就地保存且开启自动备份：滚动备份当前磁盘文件（<file>.bak / .bak.1 / .bak.2 ...）
/// 5. rename 原子替换目标文件
/// 6. 校验层二：对目标文件计算 SHA-256 与写入时哈希比对（确认 rename 后文件系统完整；
///    超过 500MB 的大文件自动跳过，避免额外一次完整读取）
///
/// 写回原文件时必须先解除 mmap（Windows 上被映射的文件无法被 rename 覆盖），
/// 成功后重新映射；另存为则不动当前打开的文件。
/// 返回 (保存结果, 应放回 state 的文件句柄)；失败时句柄为原文件或重开的原文件。
/// 校验层一失败时临时文件保留在磁盘供用户检查。
const VERIFY_SKIP_SIZE: u64 = 500 * 1024 * 1024;

/// 边写出边累计 SHA-256 的包装写入器（与写盘共享 I/O，无额外读取开销）
struct HashWriter<W: Write> {
    inner: W,
    hasher: Sha256,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.hasher.update(buf);
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// 分块计算一个磁盘文件的 SHA-256（8MB 缓冲，控制内存占用）
fn hash_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("无法打开文件进行校验: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 保存前滚动备份：保留 backup_count 份（<file>.bak 最新，.bak.N 最旧）。
/// 滚动规则：删最旧 → 依次后移 → 当前文件复制为 .bak。备份失败视为保存失败（保护旧内容）。
fn rolling_backup(path: &str, backup_count: u32) -> Result<(), String> {
    let p = Path::new(path);
    let dir = p.parent().ok_or_else(|| "无法确定文件目录".to_string())?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let bak = |i: u32| {
        if i == 0 {
            dir.join(format!("{}.bak", name))
        } else {
            dir.join(format!("{}.bak.{}", name, i))
        }
    };
    if backup_count > 1 {
        // 删最旧一份
        let _ = fs::remove_file(bak(backup_count - 1));
        // bak.(i-1) → bak.i（从后往前），rename 目标存在时在 Windows 上为原子替换
        for i in (2..backup_count).rev() {
            let from = bak(i - 1);
            if from.exists() {
                fs::rename(&from, bak(i)).map_err(|e| format!("备份滚动失败: {}", e))?;
            }
        }
        // bak → bak.1
        if bak(0).exists() {
            fs::rename(bak(0), bak(1)).map_err(|e| format!("备份滚动失败: {}", e))?;
        }
    }
    // 当前文件 → bak（覆盖写）
    fs::copy(path, bak(0)).map_err(|e| format!("创建备份失败: {}", e))?;
    Ok(())
}

fn save_file_blocking(
    opened: Arc<OpenedFile>,
    edits: Arc<Mutex<PieceTable>>,
    changes: Vec<ByteChange>,
    path: Option<String>,
    backup_count: u32,
    verify: bool,
) -> Result<(SaveResult, Arc<OpenedFile>), (String, Option<Arc<OpenedFile>>)> {
    let in_place = path.is_none();
    let save_path = path.unwrap_or_else(|| opened.path.clone());
    if in_place && opened.is_readonly {
        return Err(("文件为只读，请改用另存为".into(), Some(opened)));
    }

    // 取出 piece 表快照（pieces + 追加缓冲），锁只在这里短暂持有
    let (pieces, append_buf) = {
        let pt = edits.lock().unwrap();
        (pt.pieces().to_vec(), pt.append_buf().to_vec())
    };
    let virtual_size: u64 = pieces.iter().map(|p| p.len).sum();

    let mut merged = std::collections::BTreeMap::new();
    for c in changes {
        if c.offset >= virtual_size {
            return Err((
                format!("偏移 {} 超出文件末尾（当前共 {} 字节）", c.offset, virtual_size),
                Some(opened),
            ));
        }
        merged.insert(c.offset, c.value);
    }

    let src: &[u8] = opened.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
    let dir = Path::new(&save_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".hexsave-{}-{}", std::process::id(), nanos));

    // 用临时 piece 表按顺序写出（from_append 的 piece 指向本地追加缓冲副本），
    // 写出的同时累计 SHA-256（与写盘共享 I/O 路径，几乎零额外开销）
    let snap = PieceTable::from_parts(pieces, append_buf);
    let write_hash = (|| -> std::io::Result<String> {
        let out = fs::File::create(&tmp)?;
        let mut hw = HashWriter { inner: out, hasher: Sha256::new() };
        snap.write_patched(&mut hw, src, &merged)?;
        hw.inner.sync_all()?;
        Ok(format!("{:x}", hw.hasher.finalize()))
    })();
    let write_hash = match write_hash {
        Ok(h) => h,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err((format!("写入临时文件失败: {}", e), Some(opened)));
        }
    };

    // 校验层一：临时文件重读比对（确认写出的数据正确到达磁盘）
    if verify {
        match hash_file(&tmp) {
            Ok(h) if h == write_hash => {}
            Ok(_) => {
                // 校验失败：临时文件保留供用户检查
                return Err((
                    format!(
                        "写入临时文件校验失败（写入临时文件阶段），磁盘写入可能不完整。\
                         临时文件已保留供检查: {}",
                        tmp.display()
                    ),
                    Some(opened),
                ));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err((format!("保存校验失败: {}", e), Some(opened)));
            }
        }
    }

    if !in_place {
        // 另存为：目标路径覆盖写入，当前打开的文件不受影响，也不做备份
        if let Err(e) = fs::rename(&tmp, &save_path) {
            let _ = fs::remove_file(&tmp);
            return Err((format!("另存为失败: {}", e), Some(opened)));
        }
        // 另存为同样校验目标文件（失败不影响当前打开的文件）
        if verify {
            let md = fs::metadata(&save_path).map(|m| m.len()).unwrap_or(0);
            if md <= VERIFY_SKIP_SIZE
                && !hash_file(Path::new(&save_path))
                    .map(|h| h == write_hash)
                    .unwrap_or(false)
            {
                return Err((
                    "另存为文件校验失败（替换原文件阶段），目标文件内容可能与预期不一致".to_string(),
                    Some(opened),
                ));
            }
        }
        return Ok((
            SaveResult {
                meta: FileMeta::from(opened.as_ref()),
                verified: true,
                hash: if verify { Some(write_hash) } else { None },
                verify_stage: None,
            },
            opened,
        ));
    }

    // 就地保存：rename 前先滚动备份当前磁盘内容（保护旧内容；失败则中止保存）
    if backup_count > 0 {
        if let Err(e) = rolling_backup(&save_path, backup_count) {
            let _ = fs::remove_file(&tmp);
            return Err((format!("自动备份失败，已中止保存: {}", e), Some(opened)));
        }
    }

    // 写回原文件：解除 mmap 后 rename，再重新打开映射
    let orig_path = opened.path.clone();
    drop(opened);
    if let Err(e) = fs::rename(&tmp, &save_path) {
        let _ = fs::remove_file(&tmp);
        // 原文件仍在磁盘上，重新打开恢复句柄
        return match open_mapped(&orig_path) {
            Ok(f) => Err((format!("替换原文件失败: {}", e), Some(f))),
            Err(re) => Err((format!("替换原文件失败: {}（恢复打开也失败: {}）", e, re), None)),
        };
    }
    match open_mapped(&save_path) {
        Ok(reopened) => {
            // 校验层二：rename 后对目标文件整体比对（从重开的 mmap 读取，零额外文件 I/O）；
            // 超过阈值的大文件自动跳过（避免 1–2 秒的完整读取）
            if verify && reopened.size <= VERIFY_SKIP_SIZE {
                let ok = reopened
                    .mmap_bytes()
                    .map(|m| {
                        let mut hasher = Sha256::new();
                        hasher.update(m);
                        format!("{:x}", hasher.finalize()) == write_hash
                    })
                    .unwrap_or_else(|| write_hash.is_empty());
                if !ok {
                    return Err((
                        "替换原文件后校验失败（替换原文件阶段），文件内容可能与编辑器不一致，\
                         请勿继续编辑，可在自动备份中选择恢复"
                            .to_string(),
                        Some(reopened),
                    ));
                }
            }
            let meta = FileMeta::from(reopened.as_ref());
            Ok((
                SaveResult {
                    meta,
                    verified: true,
                    hash: if verify { Some(write_hash) } else { None },
                    verify_stage: None,
                },
                reopened,
            ))
        }
        Err(e) => Err((format!("已写入但重新打开文件失败: {}", e), None)),
    }
}

/// 保存（覆盖层 + piece 表）到磁盘：path 为 None 写回当前文件，Some 为另存为。
/// 异步命令 + spawn_blocking，大文件写出不阻塞 IPC。
/// 保存期间该标签页的映射临时移除（Windows 上被映射的文件无法被 rename 覆盖），
/// 完成后（含失败恢复）放回映射；写回成功后 piece 表重置为干净基线。
/// backup_count > 0 时就地保存前滚动备份（0 = 关闭）；verify = 保存后 SHA-256 两阶段校验。
#[tauri::command]
async fn save_file(
    tab_id: String,
    changes: Vec<ByteChange>,
    path: Option<String>,
    backup_count: Option<u32>,
    verify: Option<bool>,
    state: State<'_, AppState>,
) -> Result<SaveResult, String> {
    let tab = state.remove_tab(&tab_id).ok_or("尚未打开文件")?;
    let orig_path = tab.file.path.clone();
    let opened = tab.file;
    let edits = tab.edits;
    let search_gen = tab.search_gen;
    let analysis_gen = tab.analysis_gen;
    let strings_gen = tab.strings_gen;
    let backup_count = backup_count.unwrap_or(0).min(10);
    let verify = verify.unwrap_or(true);
    // 就地保存成功：磁盘已是新内容，piece 表重置为干净基线；
    // 其余情况（另存为 / 任何失败）：磁盘上的当前文件未变，保留原 piece 表（未保存编辑不丢）
    let in_place = path.is_none();
    let edits_for_save = edits.clone();
    let rebuild = move |file: Arc<OpenedFile>, reset_edits: bool| {
        if reset_edits {
            TabState::rebuild(file, search_gen, analysis_gen, strings_gen)
        } else {
            TabState { file, edits, search_gen, analysis_gen, strings_gen }
        }
    };
    let handle = tauri::async_runtime::spawn_blocking(move || {
        save_file_blocking(opened, edits_for_save, changes, path, backup_count, verify)
    });
    match handle.await {
        Ok(Ok((result, file))) => {
            state.insert_tab(tab_id, rebuild(file, in_place));
            Ok(result)
        }
        Ok(Err((msg, Some(file)))) => {
            state.insert_tab(tab_id, rebuild(file, false));
            Err(msg)
        }
        Ok(Err((msg, None))) => {
            // 句柄已丢失（如 panic 或重开失败），尽力恢复（原 piece 表仍对应当前磁盘内容）
            if let Ok(f) = open_mapped(&orig_path) {
                state.insert_tab(tab_id, rebuild(f, false));
            }
            Err(msg)
        }
        Err(e) => {
            if let Ok(f) = open_mapped(&orig_path) {
                state.insert_tab(tab_id, rebuild(f, false));
            }
            Err(format!("保存任务失败: {}", e))
        }
    }
}

/// 通用文本写盘（对话导出 / 模板导出等），UTF-8 编码
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败: {}", e))
}

/// 备份文件信息（list_backups 返回）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// 备份文件名（同目录下）
    pub name: String,
    pub size: u64,
    /// 修改时间（unix 秒）
    pub modified: u64,
}

/// 列出某文件当前可用的滚动备份（<file>.bak / .bak.1 / .bak.2 ...）
#[tauri::command]
fn list_backups(path: String) -> Result<Vec<BackupInfo>, String> {
    let p = Path::new(&path);
    let dir = p.parent().ok_or_else(|| "无法确定文件目录".to_string())?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let mut out = Vec::new();
    // 上限 10 份（与设置项一致），顺序为 .bak 最新 → .bak.N 最旧
    for i in 0u32..10 {
        let bak = if i == 0 {
            dir.join(format!("{}.bak", name))
        } else {
            dir.join(format!("{}.bak.{}", name, i))
        };
        if let Ok(md) = fs::metadata(&bak) {
            if md.is_file() {
                out.push(BackupInfo {
                    name: bak
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    size: md.len(),
                    modified: unix_secs(md.modified()),
                });
            }
        }
    }
    Ok(out)
}

/// 从备份恢复：把选中的备份复制回原文件路径。
/// 恢复前先把当前文件按滚动规则再归档一份（防止恢复错版本无法回退）。
/// 恢复期间释放该标签页的 mmap（Windows 上被映射的文件无法被覆盖写），
/// 成功后以新内容重新打开。backup_name 必须是该文件自己的 .bak / .bak.N（防路径注入）。
#[tauri::command]
async fn restore_backup(
    tab_id: String,
    path: String,
    backup_name: String,
    backup_count: u32,
    state: State<'_, AppState>,
) -> Result<FileMeta, String> {
    let base = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let digits_suffix = backup_name
        .strip_prefix(&format!("{}.bak", base))
        .and_then(|s| s.strip_prefix('.'));
    let valid = backup_name == format!("{}.bak", base)
        || digits_suffix
            .map(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
    if !valid {
        return Err("非法的备份文件名".into());
    }
    let full = Path::new(&path)
        .parent()
        .map(|d| d.join(&backup_name))
        .ok_or_else(|| "无法确定备份路径".to_string())?;
    if !full.is_file() {
        return Err("备份文件不存在".into());
    }

    // 移除标签页并立即释放 mmap（Windows 上被映射的文件无法被覆盖写）；
    // 仅保留扫描代数供恢复失败时重建句柄
    let tab = state.remove_tab(&tab_id);
    let gens = tab
        .as_ref()
        .map(|t| (t.search_gen.clone(), t.analysis_gen.clone(), t.strings_gen.clone()));
    drop(tab);
    let reinsert = |f: Arc<OpenedFile>| {
        if let Some((sg, ag, stg)) = &gens {
            state.insert_tab(
                tab_id.clone(),
                TabState::rebuild(f, sg.clone(), ag.clone(), stg.clone()),
            );
        }
    };
    // 1. 当前内容先归档一份（滚动备份）
    if let Err(e) = rolling_backup(&path, backup_count.max(1).min(10)) {
        if let Ok(f) = open_mapped(&path) {
            reinsert(f);
        }
        return Err(format!("恢复前备份当前内容失败: {}", e));
    }
    // 2. 备份覆盖原文件
    if let Err(e) = fs::copy(&full, &path) {
        if let Ok(f) = open_mapped(&path) {
            reinsert(f);
        }
        return Err(format!("恢复失败: {}", e));
    }
    // 3. 重新打开（piece 表重置为干净基线；前端已在此之前丢弃未保存编辑）
    match open_mapped(&path) {
        Ok(f) => {
            let meta = FileMeta::from(f.as_ref());
            reinsert(f);
            Ok(meta)
        }
        Err(e) => Err(format!("恢复完成但重新打开文件失败: {}", e)),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub offset: u64,
    /// 命中位置开始的上下文字节（最多 32 个）
    pub context: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub tab_id: String,
    pub searched: u64,
    pub total: u64,
    pub hits: usize,
}

fn parse_pattern(mode: &str, pattern: &str) -> Result<Vec<u8>, String> {
    if pattern.is_empty() {
        return Err("搜索内容为空".into());
    }
    if mode == "hex" {
        let cleaned: String = pattern
            .chars()
            .filter(|c| !matches!(c, ' ' | ':' | ',' | '-' | '_' | '.'))
            .collect();
        let s = if cleaned.len() >= 2
            && (cleaned.starts_with("0x") || cleaned.starts_with("0X"))
        {
            cleaned[2..].to_string()
        } else {
            cleaned
        };
        if s.is_empty() {
            return Err("搜索内容为空".into());
        }
        if s.len() % 2 != 0 {
            return Err("Hex 模式的字节长度必须为偶数（如 \"AB CD\" 或 \"ABCD\"）".into());
        }
        if s.len() / 2 > MAX_PATTERN_LEN {
            return Err("搜索内容过长".into());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(&s[i..i + 2], 16)
                    .map_err(|_| format!("无效的 Hex 字节: \"{}\"", &s[i..i + 2]))
            })
            .collect()
    } else {
        if pattern.len() > MAX_PATTERN_LEN {
            return Err("搜索内容过长".into());
        }
        Ok(pattern.as_bytes().to_vec())
    }
}

/// 在 mmap 数据上执行 memchr 加速的子串搜索。
/// 分块扫描（块间带重叠以捕捉跨块匹配），每个块后检查取消标志并发进度事件。
fn scan_search(
    app: &tauri::AppHandle,
    tab_id: &str,
    data: &[u8],
    gen: &AtomicU64,
    my_gen: u64,
    pat: &[u8],
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    let n = data.len();
    if pat.is_empty() || pat.len() > n {
        return Ok(Vec::new());
    }
    let max_results = max_results.clamp(1, 100_000);
    let first = pat[0];
    let first_up = first.to_ascii_uppercase();
    // 大小写不敏感时，首字节的大小写两种形态都要作为候选
    let first_variants: Vec<u8> = if !case_sensitive && first_up != first {
        vec![first.to_ascii_lowercase(), first_up]
    } else {
        vec![first]
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut block_start: usize = 0;
    let _ = app.emit(
        "search://progress",
        SearchProgress {
            tab_id: tab_id.to_string(),
            searched: 0,
            total: n as u64,
            hits: 0,
        },
    );

    'blocks: while block_start < n {
        if gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let block_end = (block_start + SCAN_BLOCK).min(n);
        // 带重叠的扫描窗口，保证跨块边界的匹配不遗漏
        let scan_end = (block_end + pat.len() - 1).min(n);
        let slice = &data[block_start..scan_end];
        for &fb in &first_variants {
            for pos in memchr::memchr_iter(fb, slice) {
                let file_pos = block_start + pos;
                // 落在重叠区的候选留给下一个块处理，避免重复命中
                if file_pos >= block_end {
                    continue;
                }
                if file_pos + pat.len() > n {
                    continue;
                }
                let candidate = &data[file_pos..file_pos + pat.len()];
                let matched = if case_sensitive {
                    candidate == pat
                } else {
                    candidate.eq_ignore_ascii_case(pat)
                };
                if matched {
                    let ctx_end = (file_pos + 32).min(n);
                    hits.push(SearchHit {
                        offset: file_pos as u64,
                        context: data[file_pos..ctx_end].to_vec(),
                    });
                    if hits.len() >= max_results {
                        break 'blocks;
                    }
                }
            }
        }
        let _ = app.emit(
            "search://progress",
            SearchProgress {
                tab_id: tab_id.to_string(),
                searched: block_end as u64,
                total: n as u64,
                hits: hits.len(),
            },
        );
        block_start = block_end;
    }

    // 两个大小写变体的扫描顺序可能导致乱序，统一排序
    hits.sort_by_key(|h| h.offset);
    hits.dedup_by_key(|h| h.offset);
    let _ = app.emit(
        "search://progress",
        SearchProgress {
            tab_id: tab_id.to_string(),
            searched: n as u64,
            total: n as u64,
            hits: hits.len(),
        },
    );
    Ok(hits)
}

/// 全文件搜索（标签页）。异步命令 + spawn_blocking，不阻塞 IPC；
/// 通过代数（generation）机制支持取消与结果作废。
#[tauri::command]
async fn search(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    mode: String,
    pattern: String,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    let pat = parse_pattern(&mode, &pattern)?;
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let gen = tab.search_gen.clone();
    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;
    let file = tab.file;
    let tab_id_for_scan = tab_id.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        scan_search(
            &app,
            &tab_id_for_scan,
            data,
            &gen,
            my_gen,
            &pat,
            case_sensitive,
            max_results,
        )
    });
    handle
        .await
        .map_err(|e| format!("搜索任务失败: {}", e))?
}

/// 取消指定标签页正在进行的搜索（代数 +1 使旧扫描作废）
#[tauri::command]
fn cancel_search(tab_id: String, state: State<AppState>) {
    if let Some(tab) = state.get_tab(&tab_id) {
        tab.search_gen.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub tab_id: String,
    pub searched: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStats {
    pub total: u64,
    /// 可打印 ASCII 字符（32..=126）
    pub printable: u64,
    /// 控制字符（不含 \n 与 \0）
    pub control: u64,
    /// 高位字节（>= 0x80，UTF-8 / 二进制数据）
    pub high: u64,
    /// 零字节
    pub zero: u64,
    /// 换行符数量
    pub line_breaks: u64,
    /// 逐字节值分布（0x00..=0xFF 的出现次数，与统计扫描一次遍历同时得到）
    pub histogram: Vec<u64>,
}

fn scan_stats(
    app: &tauri::AppHandle,
    tab_id: &str,
    data: &[u8],
    gen: &AtomicU64,
    my_gen: u64,
) -> Result<FileStats, String> {
    let n = data.len();
    let mut stats = FileStats {
        total: n as u64,
        printable: 0,
        control: 0,
        high: 0,
        zero: 0,
        line_breaks: 0,
        histogram: vec![0u64; 256],
    };
    let hist = stats.histogram.as_mut_slice();
    let mut i = 0usize;
    while i < n {
        if gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let block_end = (i + SCAN_BLOCK).min(n);
        for &b in &data[i..block_end] {
            hist[b as usize] += 1;
            match b {
                0 => stats.zero += 1,
                10 => stats.line_breaks += 1,
                32..=126 => stats.printable += 1,
                128..=255 => stats.high += 1,
                _ => stats.control += 1,
            }
        }
        let _ = app.emit(
            "analysis://progress",
            AnalysisProgress {
                tab_id: tab_id.to_string(),
                searched: block_end as u64,
                total: n as u64,
            },
        );
        i = block_end;
    }
    Ok(stats)
}

/// 后台统计分析全文件（字符数 / 零字节 / 高位字节等），带进度事件、可取消
#[tauri::command]
async fn analyze_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<FileStats, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let gen = tab.analysis_gen.clone();
    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;
    let file = tab.file;
    let tab_id_for_scan = tab_id.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        scan_stats(&app, &tab_id_for_scan, data, &gen, my_gen)
    });
    handle
        .await
        .map_err(|e| format!("统计任务失败: {}", e))?
}

// ============ 字符串提取（分析选项卡） ============

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StringHit {
    pub offset: u64,
    /// ascii / utf-8 / utf-16le / utf-16be
    pub encoding: String,
    /// 字节长度
    pub length: u64,
    /// 解码文本（超长截断为 MAX_TEXT_CHARS + 省略号）
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StringsResult {
    pub hits: Vec<StringHit>,
    /// 命中总数（可能多于返回条数）
    pub total: u64,
}

/// 结果收集器：计数不设限，返回条数封顶
#[derive(Default)]
struct HitSink {
    hits: Vec<StringHit>,
    total: u64,
}

impl HitSink {
    fn push(&mut self, offset: usize, byte_len: usize, enc: &str, text: String) {
        self.total += 1;
        if self.hits.len() < MAX_STRING_HITS {
            let text = if text.chars().count() > MAX_TEXT_CHARS {
                let mut t: String = text.chars().take(MAX_TEXT_CHARS).collect();
                t.push('…');
                t
            } else {
                text
            };
            self.hits.push(StringHit {
                offset: offset as u64,
                encoding: enc.to_string(),
                length: byte_len as u64,
                text,
            });
        }
    }
}

fn printable_ascii(b: u8) -> bool {
    (0x20..=0x7e).contains(&b)
}

/// UTF-16 可读字符：可打印 ASCII / 常用拼音文字 / CJK / 全角（排除代理区）
fn utf16_readable(u: u16) -> bool {
    matches!(u,
        0x20..=0x7e            // 可打印 ASCII
        | 0xa0..=0x24f          // 拉丁扩展
        | 0x370..=0x3ff         // 希腊
        | 0x400..=0x4ff         // 西里尔
        | 0x3000..=0x30ff       // CJK 标点 + 假名
        | 0x3400..=0x4dbf       // CJK 扩展 A
        | 0x4e00..=0x9fff       // CJK 统一表意
        | 0xac00..=0xd7a3       // 谚文音节
        | 0xff00..=0xffef       // 全角形式
    )
}

/// ASCII 可打印字符串扫描（连续 0x20..=0x7E，字节数 >= min_length）
fn scan_ascii(
    data: &[u8],
    min_length: usize,
    sink: &mut HitSink,
    gen: &AtomicU64,
    my_gen: u64,
) -> Result<(), String> {
    let mut start: Option<usize> = None;
    for i in 0..=data.len() {
        if i % STRINGS_BLOCK == 0 && gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let printable = i < data.len() && printable_ascii(data[i]);
        if printable {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            if i - s >= min_length {
                let text = String::from_utf8_lossy(&data[s..i]).into_owned();
                sink.push(s, i - s, "ascii", text);
            }
        }
    }
    Ok(())
}

/// UTF-8 多字节字符段落扫描（连续合法多字节序列，字符数 >= min_length；
/// 纯 ASCII 段落由 ASCII 扫描负责，这里遇到 ASCII 字节即断开）
fn scan_utf8(
    data: &[u8],
    min_length: usize,
    sink: &mut HitSink,
    gen: &AtomicU64,
    my_gen: u64,
) -> Result<(), String> {
    let mut run_start: Option<usize> = None;
    let mut run_chars = 0usize;
    let flush = |run_start: &mut Option<usize>, run_chars: usize, end: usize, sink: &mut HitSink| {
        if let Some(s) = *run_start {
            if run_chars >= min_length && end > s {
                let text = String::from_utf8_lossy(&data[s..end]).into_owned();
                sink.push(s, end - s, "utf-8", text);
            }
        }
        *run_start = None;
    };
    let mut i = 0usize;
    while i < data.len() {
        if i % STRINGS_BLOCK == 0 && gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let b = data[i];
        if b < 0x80 {
            flush(&mut run_start, run_chars, i, sink);
            run_chars = 0;
            i += 1;
            continue;
        }
        let seq_len = match b {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => {
                flush(&mut run_start, run_chars, i, sink);
                run_chars = 0;
                i += 1;
                continue;
            }
        };
        let ok = i + seq_len <= data.len()
            && data[i + 1..i + seq_len]
                .iter()
                .all(|&c| (0x80..=0xbf).contains(&c))
            && std::str::from_utf8(&data[i..i + seq_len]).is_ok();
        if !ok {
            flush(&mut run_start, run_chars, i, sink);
            run_chars = 0;
            i += 1;
            continue;
        }
        if run_start.is_none() {
            run_start = Some(i);
        }
        run_chars += 1;
        i += seq_len;
    }
    flush(&mut run_start, run_chars, data.len(), sink);
    Ok(())
}

/// UTF-16 字符串扫描（偶数偏移起、步长 2，可读单元连续段落 >= min_length 个字符）
fn scan_utf16(
    data: &[u8],
    big_endian: bool,
    min_length: usize,
    enc: &str,
    sink: &mut HitSink,
    gen: &AtomicU64,
    my_gen: u64,
) -> Result<(), String> {
    let mut run_start: Option<usize> = None;
    let mut units: Vec<u16> = Vec::new();
    let flush =
        |run_start: &mut Option<usize>, units: &mut Vec<u16>, sink: &mut HitSink| {
            if let Some(s) = *run_start {
                if units.len() >= min_length {
                    let text: String = units
                        .iter()
                        .map(|&u| char::from_u32(u as u32).unwrap_or('\u{fffd}'))
                        .collect();
                    sink.push(s, units.len() * 2, enc, text);
                }
            }
            *run_start = None;
            units.clear();
        };
    let mut i = 0usize;
    while i + 1 < data.len() {
        if i % STRINGS_BLOCK == 0 && gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let u = if big_endian {
            u16::from_be_bytes([data[i], data[i + 1]])
        } else {
            u16::from_le_bytes([data[i], data[i + 1]])
        };
        if utf16_readable(u) {
            if run_start.is_none() {
                run_start = Some(i);
            }
            units.push(u);
        } else {
            flush(&mut run_start, &mut units, sink);
        }
        i += 2;
    }
    flush(&mut run_start, &mut units, sink);
    Ok(())
}

/// 全文件字符串提取（标签页）。mmap 连续扫描（无跨块边界问题），
/// 每 8MB 检查一次取消代数；结果封顶 5000 条但总数照常统计。
#[tauri::command]
async fn extract_strings(
    state: State<'_, AppState>,
    tab_id: String,
    min_length: u32,
    encodings: Vec<String>,
) -> Result<StringsResult, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let gen = tab.strings_gen.clone();
    // 新扫描自动作废上一次（前端"刷新"即取消重扫）
    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;
    let file = tab.file;
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        let min_length = (min_length as usize).clamp(1, 1024);
        let mut sink = HitSink::default();
        let mut r = Ok(());
        if encodings.iter().any(|e| e == "ascii") {
            r = scan_ascii(data, min_length, &mut sink, &gen, my_gen);
        }
        if r.is_ok() && encodings.iter().any(|e| e == "utf-8") {
            r = scan_utf8(data, min_length, &mut sink, &gen, my_gen);
        }
        if r.is_ok() && encodings.iter().any(|e| e == "utf-16le") {
            r = scan_utf16(data, false, min_length, "utf-16le", &mut sink, &gen, my_gen);
        }
        if r.is_ok() && encodings.iter().any(|e| e == "utf-16be") {
            r = scan_utf16(data, true, min_length, "utf-16be", &mut sink, &gen, my_gen);
        }
        r.map(|_| {
            sink.hits.sort_by_key(|h| h.offset);
            StringsResult {
                hits: sink.hits,
                total: sink.total,
            }
        })
    });
    handle
        .await
        .map_err(|e| format!("字符串扫描任务失败: {}", e))?
}

// ============ 校验和计算（分析选项卡） ============

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checksums {
    pub len: u64,
    pub crc32: String,
    pub crc16: String,
    pub adler32: String,
    pub md5: String,
    pub sha1: String,
    pub sha256: String,
    pub xor8: String,
    pub sum8: String,
}

/// 标准 CRC-32（IEEE 802.3，反射多项式 0xEDB88320）
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// CRC-16/CCITT-FALSE（多项式 0x1021，初值 0xFFFF，无反射）
fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

/// Adler-32
fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// 对指定标签页的磁盘内容（不含未保存编辑）计算选中区间校验和。
/// 区间上限 4MB；结果为小写十六进制字符串。
#[tauri::command]
fn compute_checksums(
    tab_id: String,
    offset: u64,
    len: u64,
    state: State<AppState>,
) -> Result<Checksums, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let file = tab.file;
    if file.size == 0 || offset >= file.size {
        return Err("区间为空".into());
    }
    let end = offset.saturating_add(len).min(file.size);
    let real_len = end - offset;
    if real_len > MAX_CHECKSUM_LEN {
        return Err(format!("选择过大（{} 字节），仅支持 4MB 以内", real_len));
    }
    let data = file.mmap_bytes().unwrap_or(&[]);
    let s = offset as usize;
    let e = end as usize;
    if s >= data.len() {
        return Err("区间为空".into());
    }
    let slice = &data[s..e.min(data.len())];
    let mut xor8 = 0u8;
    let mut sum8 = 0u8;
    for &b in slice {
        xor8 ^= b;
        sum8 = sum8.wrapping_add(b);
    }
    Ok(Checksums {
        len: slice.len() as u64,
        crc32: format!("{:08x}", crc32(slice)),
        crc16: format!("{:04x}", crc16_ccitt(slice)),
        adler32: format!("{:08x}", adler32(slice)),
        md5: format!("{:x}", md5::compute(slice)),
        sha1: format!("{:x}", sha1::Sha1::digest(slice)),
        sha256: format!("{:x}", Sha256::digest(slice)),
        xor8: format!("{:02x}", xor8),
        sum8: format!("{:02x}", sum8),
    })
}

#[derive(Clone, Serialize)]
pub struct PerfInfo {
    /// 进程物理内存占用（字节）
    pub memory: u64,
    /// 进程 CPU 占用率（%）
    pub cpu: f32,
}

/// 采集本进程的内存 / CPU 占用（前端 1Hz 轮询）
#[tauri::command]
fn get_perf(state: State<AppState>) -> PerfInfo {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = state.sys.lock().unwrap();
    let _ = sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid) {
        Some(p) => PerfInfo {
            memory: p.memory(),
            cpu: p.cpu_usage(),
        },
        None => PerfInfo { memory: 0, cpu: 0.0 },
    }
}

// ============ 对比模式（v1.1.4） ============

/// 差异区间：两边文件在 [start, start+len) 内不同（或该区间只存在于较长的一侧）
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRange {
    pub start: u64,
    pub len: u64,
}

/// 相邻差异合并的最大间隙（字节）：间隙内的相同字节并入区间，减少区间数量
const DIFF_MERGE_GAP: u64 = 16;
/// 差异区间数量上限（超出截断，前端提示）
const MAX_DIFF_RANGES: usize = 100_000;

/// 逐字节比较两个已打开标签页的磁盘内容，返回差异区间列表。
/// 只比较两边都存在的位置；多出的尾部作为一个整体区间返回。
#[tauri::command]
async fn diff_files(
    state: State<'_, AppState>,
    tab_id_a: String,
    tab_id_b: String,
) -> Result<Vec<DiffRange>, String> {
    let tab_a = state.get_tab(&tab_id_a).ok_or("文件 A 尚未打开")?;
    let tab_b = state.get_tab(&tab_id_b).ok_or("文件 B 尚未打开")?;
    let a = tab_a.file;
    let b = tab_b.file;
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let da: &[u8] = a.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        let db: &[u8] = b.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        let common = da.len().min(db.len());
        let mut ranges: Vec<DiffRange> = Vec::new();
        let mut cur_start: Option<u64> = None;
        let mut cur_end: u64 = 0;
        let block = 4 * 1024 * 1024;
        let mut pos = 0usize;
        while pos < common {
            let take = block.min(common - pos);
            let a_slice = &da[pos..pos + take];
            let b_slice = &db[pos..pos + take];
            if a_slice == b_slice {
                // 整块相同：与当前区段的间隙超过阈值则收尾
                if let Some(s) = cur_start {
                    if pos as u64 - cur_end > DIFF_MERGE_GAP {
                        ranges.push(DiffRange { start: s, len: (cur_end - s).max(1) });
                        cur_start = None;
                    }
                }
            } else {
                for i in 0..take {
                    if a_slice[i] != b_slice[i] {
                        let off = (pos + i) as u64;
                        match cur_start {
                            Some(s) if off - cur_end <= DIFF_MERGE_GAP => {
                                let _ = s;
                                cur_end = off + 1;
                            }
                            Some(s) => {
                                ranges.push(DiffRange { start: s, len: (cur_end - s).max(1) });
                                cur_start = Some(off);
                                cur_end = off + 1;
                            }
                            None => {
                                cur_start = Some(off);
                                cur_end = off + 1;
                            }
                        }
                        if ranges.len() >= MAX_DIFF_RANGES {
                            break;
                        }
                    }
                }
                if ranges.len() >= MAX_DIFF_RANGES {
                    break;
                }
            }
            pos += take;
        }
        if let Some(s) = cur_start {
            ranges.push(DiffRange { start: s, len: (cur_end - s).max(1) });
        }
        // 长度差异：多出的尾部整体作为一个区间
        let (la, lb) = (da.len() as u64, db.len() as u64);
        if la != lb {
            ranges.push(DiffRange { start: la.min(lb), len: la.max(lb) - la.min(lb) });
        }
        ranges
    });
    handle.await.map_err(|e| format!("差异计算任务失败: {}", e))
}

// ============ 熵图（v1.1.4） ============

/// 计算磁盘内容按块大小的香农熵（0..=8 bit/byte）。
/// 实际块大小 = max(用户选择, 文件大小/4000)，防止超大文件产生过多分块。
#[tauri::command]
async fn compute_entropy(
    state: State<'_, AppState>,
    tab_id: String,
    block_size: u64,
) -> Result<Vec<f32>, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let file = tab.file;
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        let n = data.len() as u64;
        if n == 0 {
            return Vec::new();
        }
        let target_blocks = 4000u64;
        let min_block = n.div_ceil(target_blocks);
        let block = block_size.max(min_block).max(1);
        let mut out = Vec::with_capacity((n / block + 1) as usize);
        let mut pos = 0usize;
        while pos < data.len() {
            let end = (pos + block as usize).min(data.len());
            let mut bins = [0u64; 256];
            for &b in &data[pos..end] {
                bins[b as usize] += 1;
            }
            let total = (end - pos) as f64;
            let mut h = 0f64;
            for &c in bins.iter() {
                if c > 0 {
                    let p = c as f64 / total;
                    h -= p * p.log2();
                }
            }
            out.push(h as f32);
            pos = end;
        }
        out
    });
    handle.await.map_err(|e| format!("熵计算任务失败: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_file,
            close_tab,
            get_file_meta,
            read_file_bytes,
            find_first_byte,
            read_chunk,
            insert_bytes,
            delete_range,
            get_virtual_size,
            save_file,
            write_text_file,
            list_backups,
            restore_backup,
            search,
            cancel_search,
            analyze_file,
            extract_strings,
            compute_checksums,
            diff_files,
            compute_entropy,
            get_perf,
            versions::list_versions,
            versions::save_version,
            versions::load_version_diff,
            versions::delete_version,
            versions::rename_version,
            versions::cleanup_versions,
            versions::versions_global_size,
            autosave::save_autosave,
            autosave::load_autosave,
            autosave::clear_autosave
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
