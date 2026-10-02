// 大文件优化版后端：
// - mmap 内存映射，按需返回字节切片（前端虚拟滚动按需请求）
// - 高速搜索（memchr 加速 + 进度事件 + 可取消）
// - 后台全文件统计分析（字符数等，带进度）
// - 进程内存 / CPU 性能数据
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use memmap2::Mmap;
use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Emitter, State};

/// 单次 read_chunk 返回的最大字节数
const MAX_CHUNK_LEN: u64 = 8 * 1024 * 1024;
/// 搜索 / 统计扫描的分块大小（同时是进度事件与取消检查的粒度）
const SCAN_BLOCK: usize = 32 * 1024 * 1024;
/// 搜索模式的最大长度
const MAX_PATTERN_LEN: usize = 4096;

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

pub struct AppState {
    file: Mutex<Option<Arc<OpenedFile>>>,
    /// 搜索代数：每次新搜索 / 取消 / 打开新文件时递增，旧扫描检测到不一致即中止
    search_gen: Arc<AtomicU64>,
    /// 统计分析代数：同上
    analysis_gen: Arc<AtomicU64>,
    sys: Mutex<System>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            file: Mutex::new(None),
            search_gen: Arc::new(AtomicU64::new(0)),
            analysis_gen: Arc::new(AtomicU64::new(0)),
            sys: Mutex::new(System::new()),
        }
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

/// 打开文件：只建立 mmap 映射并返回元数据，不把文件读入内存
#[tauri::command]
fn open_file(path: String, state: State<AppState>) -> Result<FileMeta, String> {
    // 打开新文件时中止仍在运行的搜索 / 统计
    state.search_gen.fetch_add(1, Ordering::SeqCst);
    state.analysis_gen.fetch_add(1, Ordering::SeqCst);

    let opened = open_mapped(&path)?;
    let meta = FileMeta::from(opened.as_ref());
    *state.file.lock().unwrap() = Some(opened);
    Ok(meta)
}

/// 按需读取字节切片（返回原始二进制，避免 JSON 序列化开销）
#[tauri::command]
fn read_chunk(offset: u64, length: u64, state: State<AppState>) -> Result<tauri::ipc::Response, String> {
    let file = state
        .file
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未打开文件")?;
    if file.size == 0 || offset >= file.size {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let len = length.min(file.size - offset).min(MAX_CHUNK_LEN) as usize;
    let start = offset as usize;
    let bytes = if let Some(m) = &file.mmap {
        let end = (start + len).min(m.len());
        if start < end {
            m[start..end].to_vec()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// 前端覆盖层的单条字节修改
#[derive(serde::Deserialize)]
pub struct ByteChange {
    pub offset: u64,
    pub value: u8,
}

/// 保存的核心流程（阻塞线程内执行）：
/// 1. 合并同一偏移的多次修改（BTreeMap 自动按偏移有序）
/// 2. 原文件内容 + 修改 → 写同目录临时文件（sync 落盘）
/// 3. rename 原子替换目标文件
///
/// 写回原文件时必须先解除 mmap（Windows 上被映射的文件无法被 rename 覆盖），
/// 成功后重新映射；另存为则不动当前打开的文件。
/// 返回 (新元数据, 应放回 state 的文件句柄)；失败时句柄为原文件或重开的原文件。
fn save_file_blocking(
    opened: Arc<OpenedFile>,
    changes: Vec<ByteChange>,
    path: Option<String>,
) -> Result<(FileMeta, Arc<OpenedFile>), (String, Option<Arc<OpenedFile>>)> {
    let in_place = path.is_none();
    let save_path = path.unwrap_or_else(|| opened.path.clone());
    if in_place && opened.is_readonly {
        return Err(("文件为只读，请改用另存为".into(), Some(opened)));
    }

    let mut merged = std::collections::BTreeMap::new();
    for c in changes {
        if c.offset >= opened.size {
            return Err((
                format!("偏移 {} 超出文件末尾（文件共 {} 字节）", c.offset, opened.size),
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

    let write = (|| -> std::io::Result<()> {
        let mut out = fs::File::create(&tmp)?;
        let mut pos: u64 = 0;
        for (off, val) in &merged {
            if *off > pos {
                out.write_all(&src[pos as usize..*off as usize])?;
            }
            out.write_all(&[*val])?;
            pos = off + 1;
        }
        if (pos as usize) < src.len() {
            out.write_all(&src[pos as usize..])?;
        }
        out.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err((format!("写入临时文件失败: {}", e), Some(opened)));
    }

    if !in_place {
        // 另存为：目标路径覆盖写入，当前打开的文件不受影响
        return match fs::rename(&tmp, &save_path) {
            Ok(()) => Ok((FileMeta::from(opened.as_ref()), opened)),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err((format!("另存为失败: {}", e), Some(opened)))
            }
        };
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
            let meta = FileMeta::from(reopened.as_ref());
            Ok((meta, reopened))
        }
        Err(e) => Err((format!("已写入但重新打开文件失败: {}", e), None)),
    }
}

/// 保存覆盖层修改：path 为 None 写回当前文件，Some 为另存为。
/// 异步命令 + spawn_blocking，大文件复制不阻塞 IPC。
#[tauri::command]
async fn save_file(
    changes: Vec<ByteChange>,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<FileMeta, String> {
    let opened = state
        .file
        .lock()
        .unwrap()
        .take()
        .ok_or("尚未打开文件")?;
    let orig_path = opened.path.clone();
    let handle =
        tauri::async_runtime::spawn_blocking(move || save_file_blocking(opened, changes, path));
    match handle.await {
        Ok(Ok((meta, file))) => {
            *state.file.lock().unwrap() = Some(file);
            Ok(meta)
        }
        Ok(Err((msg, Some(file)))) => {
            *state.file.lock().unwrap() = Some(file);
            Err(msg)
        }
        Ok(Err((msg, None))) => {
            // 句柄已丢失（如 panic 或重开失败），尽力恢复
            if let Ok(f) = open_mapped(&orig_path) {
                *state.file.lock().unwrap() = Some(f);
            }
            Err(msg)
        }
        Err(e) => {
            if let Ok(f) = open_mapped(&orig_path) {
                *state.file.lock().unwrap() = Some(f);
            }
            Err(format!("保存任务失败: {}", e))
        }
    }
}

#[derive(Clone, Serialize)]
pub struct SearchHit {
    pub offset: u64,
    /// 命中位置开始的上下文字节（最多 32 个）
    pub context: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct SearchProgress {
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
            searched: n as u64,
            total: n as u64,
            hits: hits.len(),
        },
    );
    Ok(hits)
}

/// 全文件搜索。异步命令 + spawn_blocking，不阻塞 IPC；
/// 通过代数（generation）机制支持取消与结果作废。
#[tauri::command]
async fn search(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: String,
    pattern: String,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    let pat = parse_pattern(&mode, &pattern)?;
    let file = state
        .file
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未打开文件")?;
    let gen = state.search_gen.clone();
    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        scan_search(&app, data, &gen, my_gen, &pat, case_sensitive, max_results)
    });
    handle
        .await
        .map_err(|e| format!("搜索任务失败: {}", e))?
}

#[tauri::command]
fn cancel_search(state: State<AppState>) {
    state.search_gen.fetch_add(1, Ordering::SeqCst);
}

#[derive(Clone, Serialize)]
pub struct AnalysisProgress {
    pub searched: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
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
}

fn scan_stats(
    app: &tauri::AppHandle,
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
    };
    let mut i = 0usize;
    while i < n {
        if gen.load(Ordering::Relaxed) != my_gen {
            return Err("已取消".into());
        }
        let block_end = (i + SCAN_BLOCK).min(n);
        for &b in &data[i..block_end] {
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
) -> Result<FileStats, String> {
    let file = state
        .file
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未打开文件")?;
    let gen = state.analysis_gen.clone();
    let my_gen = gen.fetch_add(1, Ordering::SeqCst) + 1;

    let handle = tauri::async_runtime::spawn_blocking(move || {
        let data: &[u8] = file.mmap.as_ref().map(|m| &m[..]).unwrap_or(&[]);
        scan_stats(&app, data, &gen, my_gen)
    });
    handle
        .await
        .map_err(|e| format!("统计任务失败: {}", e))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_file,
            read_chunk,
            save_file,
            search,
            cancel_search,
            analyze_file,
            get_perf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
