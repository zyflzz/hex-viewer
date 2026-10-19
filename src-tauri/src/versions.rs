// 历史版本存储（v1.1.4，格式 v2）：
// 每个文件一个目录 <app_data>/hex-viewer/versions/<sha256(path)[0..16]>/：
// - base.bin         基线快照（首次记录版本时从磁盘内容全量拷贝，所有版本共享）
// - meta.json        版本索引（format: 2），存储顺序 = 时间顺序（最新在末尾）
// - v<id>.json.zst   单版本完整数据（ops 快照 + pos + 内容差异），zstd 压缩
//
// v2 差异语义（支持变长编辑）：版本内容 = base.bin + 差异，两种形态互斥：
// - overlay（等长）：逐字节点差异 [offset, version_value]
// - structural（变长）：公共前缀 + 中段替换（base 中段长度 + 版本中段字节）+ 隐式公共后缀
// 记录时直接对比 base.bin 与当前显示内容（piece 表 + 前端覆盖层补丁）；
// 恢复时对比版本内容与当前显示内容，等长返回点差异，变长返回 {offset, deleteLen, insertBytes}。
// v1 旧格式（meta.json 无 format 字段）不再兼容：读取时清空旧版本数据（保留 base.bin）。
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::{AppState, OpenedFile, TabState};
use crate::edit::{Piece, PieceTable};

/// 每个文件最多保留的版本数（超出删最旧）
const MAX_VERSIONS_PER_FILE: usize = 50;
/// 每个文件的版本数据（v 文件合计，不含 base.bin）大小上限
const MAX_VERSION_DATA_BYTES: u64 = 200 * 1024 * 1024;
/// 对比扫描缓冲区大小
const SCAN_BUF: usize = 4 * 1024 * 1024;
/// 解压版本数据的容量上限（防御异常数据）
const MAX_DECOMPRESS: usize = 512 * 1024 * 1024;
/// 变长差异中段的大小上限（超出拒绝记录/恢复）
const MAX_MID_BYTES: u64 = 128 * 1024 * 1024;

/// 版本元数据（列表展示用，不含 ops / overlay）
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    /// 记录时刻（unix 毫秒）
    pub time: u64,
    pub label: String,
    /// 相对基线的改动字节数
    pub byte_count: u64,
    /// 版本数据文件大小（压缩后，字节）
    pub size_bytes: u64,
    /// 内容指纹（ops+pos+overlay 的 sha256，用于与最新版本去重）
    pub hash: String,
}

/// 记录版本的载荷：label + 当前操作记录快照 + 当前未保存覆盖层（相对磁盘）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVersionPayload {
    pub label: String,
    /// 前端 EditOp[] 快照（Rust 不解释其结构，原样存储/返回）
    pub ops: Value,
    pub pos: u64,
    pub edits: Vec<(u64, u8)>,
}

/// 单个版本的完整数据（磁盘格式，v2）
#[derive(Serialize, Deserialize)]
struct VersionData {
    ops: Value,
    pos: u64,
    /// 等长差异：[offset, version_value]（相对 base.bin；与 structural 互斥）
    overlay: Vec<(u64, u8)>,
    /// 变长差异：base.bin 的 [prefix, prefix+base_mid_len) 中段替换为 mid
    structural: Option<StructuralSnap>,
}

/// 变长差异快照（与 overlay 互斥）
#[derive(Serialize, Deserialize, Clone)]
struct StructuralSnap {
    /// 公共前缀长度
    prefix: u64,
    /// base.bin 中被替换的中段长度
    base_mid_len: u64,
    /// 版本内容的中段字节
    mid: Vec<u8>,
}

/// 版本内容与当前显示内容的差异（恢复/预览共用）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiffChange {
    pub offset: u64,
    /// 当前显示值（覆盖层 ?? piece 表值）
    pub old_value: u8,
    /// 版本内容值
    pub new_value: u8,
}

/// 变长恢复指令：删除 [offset, offset+delete_len) 后原位插入 insert_bytes
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralDiff {
    pub offset: u64,
    pub delete_len: u64,
    pub insert_bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiff {
    pub changes: Vec<VersionDiffChange>,
    /// 因超出当前文件大小而跳过的偏移数
    pub skipped: u64,
    /// 变长差异（与 changes 互斥）：前端作为复合操作恢复
    pub structural: Option<StructuralDiff>,
}

/// 版本索引（磁盘格式）。format != 2 的旧数据读取时被清理。
#[derive(Serialize, Deserialize, Default)]
struct MetaFile {
    format: u32,
    versions: Vec<VersionMeta>,
}

const META_FORMAT: u32 = 2;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn gen_version_id() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}-{:x}",
        d.as_millis(),
        d.subsec_nanos() as u32 ^ (std::process::id() << 8)
    )
}

/// 文件路径 → 版本目录名（sha256 前 16 位，重命名文件不影响路径身份）
fn file_id(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..16].to_string()
}

fn versions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    Ok(dir.join("hex-viewer").join("versions"))
}

fn file_dir(app: &AppHandle, file_path: &str) -> PathBuf {
    versions_root(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(file_id(file_path))
}

fn version_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("v{}.json.zst", id))
}

/// 读取版本索引；缺失视为空。旧格式（无 format 字段）清空旧版本数据后返回空。
fn read_meta(dir: &Path) -> Vec<VersionMeta> {
    let raw = match fs::read(dir.join("meta.json")) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    // 先看 format 字段：旧格式（v1）不再兼容
    let legacy = serde_json::from_slice::<Value>(&raw)
        .ok()
        .map(|v| v.get("format").and_then(|f| f.as_u64()) != Some(META_FORMAT as u64))
        .unwrap_or(true);
    if legacy {
        // 清掉旧版本数据文件（base.bin 内容仍有效，保留）
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x == "zst").unwrap_or(false) {
                    let _ = fs::remove_file(p);
                }
            }
        }
        let _ = write_meta(dir, &[]);
        return Vec::new();
    }
    serde_json::from_slice::<MetaFile>(&raw)
        .ok()
        .map(|m| m.versions)
        .unwrap_or_default()
}

/// 原子写版本索引（临时文件 + rename，避免崩溃留下半成品）
fn write_meta(dir: &Path, metas: &[VersionMeta]) -> Result<(), String> {
    let json = serde_json::to_vec(&MetaFile {
        format: META_FORMAT,
        versions: metas.to_vec(),
    })
    .map_err(|e| format!("序列化版本索引失败: {}", e))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".meta-{}-{}", std::process::id(), nanos));
    fs::write(&tmp, &json).map_err(|e| format!("写入版本索引失败: {}", e))?;
    if let Err(e) = fs::rename(&tmp, dir.join("meta.json")) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换版本索引失败: {}", e));
    }
    Ok(())
}

/// 版本数据实际占用（磁盘实测，缺失按元数据估计）
fn version_data_bytes(dir: &Path, metas: &[VersionMeta]) -> u64 {
    metas
        .iter()
        .map(|m| {
            fs::metadata(version_file(dir, &m.id))
                .map(|x| x.len())
                .unwrap_or(m.size_bytes)
        })
        .sum()
}

/// 容量清理：数量 / 数据量超限时删除最旧的版本（至少保留 1 个）
fn enforce_limits(dir: &Path, metas: &mut Vec<VersionMeta>) {
    while metas.len() > MAX_VERSIONS_PER_FILE {
        let old = metas.remove(0);
        let _ = fs::remove_file(version_file(dir, &old.id));
    }
    while metas.len() > 1 && version_data_bytes(dir, metas) > MAX_VERSION_DATA_BYTES {
        let old = metas.remove(0);
        let _ = fs::remove_file(version_file(dir, &old.id));
    }
}

// ============ 内容源（对比的两侧） ============

/// 随机可读的内容源
trait ContentSource {
    fn len(&self) -> u64;
    /// 读取 [pos, pos+out.len())，返回实际读取字节数
    fn read_at(&self, pos: u64, out: &mut [u8]) -> usize;
}

/// base.bin 文件源（seek + read）
struct FileSource {
    file: fs::File,
    len: u64,
}

impl FileSource {
    fn open(path: &Path) -> Result<Self, String> {
        let file = fs::File::open(path).map_err(|e| format!("无法读取基线快照: {}", e))?;
        let len = file.metadata().map_err(|e| format!("无法读取基线快照信息: {}", e))?.len();
        Ok(FileSource { file, len })
    }
}

impl ContentSource for FileSource {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, pos: u64, out: &mut [u8]) -> usize {
        if pos >= self.len || out.is_empty() {
            return 0;
        }
        let mut f = &self.file;
        if f.seek(SeekFrom::Start(pos)).is_err() {
            return 0;
        }
        let want = out.len().min((self.len - pos) as usize);
        let mut got = 0usize;
        while got < want {
            match f.read(&mut out[got..want]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(_) => break,
            }
        }
        got
    }
}

/// 版本内容源：base.bin + overlay 补丁 或 structural 中段拼接
struct VersionSource {
    base: FileSource,
    /// 等长差异补丁（structural 为 None 时使用）
    overlay: BTreeMap<u64, u8>,
    /// 变长差异（存在时 overlay 为空）
    structural: Option<StructuralSnap>,
}

impl ContentSource for VersionSource {
    fn len(&self) -> u64 {
        match &self.structural {
            None => self.base.len(),
            Some(s) => self.base.len() - s.base_mid_len + s.mid.len() as u64,
        }
    }
    fn read_at(&self, pos: u64, out: &mut [u8]) -> usize {
        match &self.structural {
            None => {
                let n = self.base.read_at(pos, out);
                let end = pos + n as u64;
                for (&o, &v) in self.overlay.range(pos..end) {
                    out[(o - pos) as usize] = v;
                }
                n
            }
            Some(s) => {
                let mid_len = s.mid.len() as u64;
                let vlen = self.len();
                if pos >= vlen {
                    return 0;
                }
                let want = (out.len() as u64).min(vlen - pos);
                let mut done = 0usize;
                while done < want as usize {
                    let cur = pos + done as u64;
                    if cur < s.prefix {
                        // 基线前缀段
                        let take = ((s.prefix - cur).min(want - done as u64)) as usize;
                        let mut got = 0usize;
                        while got < take {
                            let n = self.base.read_at(cur + got as u64, &mut out[done + got..done + take]);
                            if n == 0 { break; }
                            got += n;
                        }
                        done += got;
                        if got < take { break; }
                    } else if cur < s.prefix + mid_len {
                        // 版本中段（内存字节）
                        let start = (cur - s.prefix) as usize;
                        let take = ((mid_len - (cur - s.prefix)).min(want - done as u64)) as usize;
                        let end = (start + take).min(s.mid.len());
                        out[done..done + (end - start)].copy_from_slice(&s.mid[start..end]);
                        done += end - start;
                    } else {
                        // 基线后缀段：映射回基线偏移
                        let base_pos = cur - mid_len + s.base_mid_len;
                        let take = ((self.base.len() - base_pos).min(want - done as u64)) as usize;
                        let mut got = 0usize;
                        while got < take {
                            let n = self.base.read_at(base_pos + got as u64, &mut out[done + got..done + take]);
                            if n == 0 { break; }
                            got += n;
                        }
                        done += got;
                        if got < take { break; }
                    }
                }
                done
            }
        }
    }
}

/// 当前显示内容源：mmap 基线 + piece 表 + 前端覆盖层补丁
struct DisplaySource<'a> {
    mmap: &'a [u8],
    pt: PieceTable,
    patch: BTreeMap<u64, u8>,
}

impl ContentSource for DisplaySource<'_> {
    fn len(&self) -> u64 {
        self.pt.virtual_size()
    }
    fn read_at(&self, pos: u64, out: &mut [u8]) -> usize {
        let data = self.pt.read(pos, out.len() as u64, self.mmap);
        let n = data.len();
        out[..n].copy_from_slice(&data);
        let end = pos + n as u64;
        for (&o, &v) in self.patch.range(pos..end) {
            out[(o - pos) as usize] = v;
        }
        n
    }
}

/// 两个内容源的差异
enum ContentDiff {
    /// 等长：点差异 (offset, from, to)
    Replaces(Vec<(u64, u8, u8)>),
    /// 变长：公共前缀 + from 中段长度 + to 中段内容（后缀隐式对齐）
    Structural { prefix: u64, from_mid_len: u64, to_mid: Vec<u8> },
}

fn diff_sources(a: &dyn ContentSource, b: &dyn ContentSource) -> Result<ContentDiff, String> {
    let (la, lb) = (a.len(), b.len());
    let mut va = vec![0u8; SCAN_BUF];
    let mut vb = vec![0u8; SCAN_BUF];
    if la == lb {
        let mut diffs = Vec::new();
        let mut pos = 0u64;
        while pos < la {
            let take = ((SCAN_BUF as u64).min(la - pos)) as usize;
            a.read_at(pos, &mut va[..take]);
            b.read_at(pos, &mut vb[..take]);
            for i in 0..take {
                if va[i] != vb[i] {
                    diffs.push((pos + i as u64, va[i], vb[i]));
                }
            }
            pos += take as u64;
        }
        return Ok(ContentDiff::Replaces(diffs));
    }
    // 变长：公共前缀
    let common = la.min(lb);
    let mut prefix = 0u64;
    while prefix < common {
        let take = ((SCAN_BUF as u64).min(common - prefix)) as usize;
        a.read_at(prefix, &mut va[..take]);
        b.read_at(prefix, &mut vb[..take]);
        if va[..take] == vb[..take] {
            prefix += take as u64;
        } else {
            let i = (0..take).find(|&i| va[i] != vb[i]).unwrap_or(take);
            prefix += i as u64;
            break;
        }
    }
    // 公共后缀（不超过剩余公共长度）
    let max_suffix = common - prefix;
    let mut suffix = 0u64;
    while suffix < max_suffix {
        let take = ((SCAN_BUF as u64).min(max_suffix - suffix)) as usize;
        a.read_at(la - suffix - take as u64, &mut va[..take]);
        b.read_at(lb - suffix - take as u64, &mut vb[..take]);
        if va[..take] == vb[..take] {
            suffix += take as u64;
        } else {
            let i = (0..take).find(|&i| va[i] != vb[i]).unwrap_or(take);
            suffix += i as u64;
            break;
        }
    }
    let from_mid_len = la - prefix - suffix;
    let to_mid_len = lb - prefix - suffix;
    if to_mid_len > MAX_MID_BYTES {
        return Err(format!("版本差异中段过大（{} 字节，上限 {}），无法处理", to_mid_len, MAX_MID_BYTES));
    }
    let mut to_mid = vec![0u8; to_mid_len as usize];
    let got = b.read_at(prefix, &mut to_mid);
    if got != to_mid_len as usize {
        return Err("读取版本差异中段失败".into());
    }
    Ok(ContentDiff::Structural { prefix, from_mid_len, to_mid })
}

/// 取标签页的 piece 表快照（锁内短暂克隆）
fn piece_snapshot(tab: &TabState) -> (Vec<Piece>, Vec<u8>) {
    let pt = tab.edits.lock().unwrap();
    (pt.pieces().to_vec(), pt.append_buf().to_vec())
}

/// 记录版本的核心流程（阻塞线程内执行）：
/// 1. 确保 base.bin 存在（首次记录 = 当前磁盘内容全量拷贝）
/// 2. 对比 base.bin 与当前显示内容（piece 表 + 覆盖层补丁）：等长存 overlay，变长存 structural
/// 3. 与最新版本内容指纹相同则跳过（返回 None）
/// 4. 写 v<id>.json.zst，更新 meta.json，执行容量清理
fn save_version_blocking(
    app: &AppHandle,
    opened: &OpenedFile,
    pieces: Vec<Piece>,
    append_buf: Vec<u8>,
    payload: SaveVersionPayload,
) -> Result<Option<VersionMeta>, String> {
    let dir = file_dir(app, &opened.path_string());
    fs::create_dir_all(&dir).map_err(|e| format!("创建版本目录失败: {}", e))?;
    let base_path = dir.join("base.bin");
    if !base_path.is_file() {
        let disk: &[u8] = opened.mmap_bytes().unwrap_or(&[]);
        fs::write(&base_path, disk).map_err(|e| format!("写入基线快照失败: {}", e))?;
    }

    let mmap: &[u8] = opened.mmap_bytes().unwrap_or(&[]);
    let display = DisplaySource {
        mmap,
        pt: PieceTable::from_parts(pieces, append_buf),
        patch: payload.edits.iter().copied().collect(),
    };
    let base = FileSource::open(&base_path)?;
    // from = base，to = 显示内容（版本内容 = base + 差异）
    let (overlay, structural, byte_count) = match diff_sources(&base, &display)? {
        ContentDiff::Replaces(diffs) => (
            diffs.iter().map(|&(o, _, v)| (o, v)).collect::<Vec<_>>(),
            None,
            diffs.len() as u64,
        ),
        ContentDiff::Structural { prefix, from_mid_len, to_mid } => (
            Vec::new(),
            Some(StructuralSnap { prefix, base_mid_len: from_mid_len, mid: to_mid.clone() }),
            from_mid_len + to_mid.len() as u64,
        ),
    };

    let data = VersionData {
        ops: payload.ops,
        pos: payload.pos,
        overlay,
        structural,
    };
    // 内容指纹：ops + pos + 差异数据（不含 label/time，纯内容比对）
    let hash = {
        let mut h = Sha256::new();
        h.update(&serde_json::to_vec(&data.ops).unwrap_or_default());
        h.update(&data.pos.to_le_bytes());
        for (o, v) in &data.overlay {
            h.update(&o.to_le_bytes());
            h.update(&[*v]);
        }
        if let Some(s) = &data.structural {
            h.update(&s.prefix.to_le_bytes());
            h.update(&s.base_mid_len.to_le_bytes());
            h.update(&(s.mid.len() as u64).to_le_bytes());
            h.update(&s.mid);
        }
        format!("{:x}", h.finalize())
    };

    let mut metas = read_meta(&dir);
    if metas.last().map(|m| m.hash == hash).unwrap_or(false) {
        return Ok(None); // 与最新版本完全相同，跳过
    }

    let json = serde_json::to_vec(&data).map_err(|e| format!("序列化版本数据失败: {}", e))?;
    let compressed =
        zstd::bulk::compress(&json, 3).map_err(|e| format!("压缩版本数据失败: {}", e))?;
    let id = gen_version_id();
    let vpath = version_file(&dir, &id);
    fs::write(&vpath, &compressed).map_err(|e| format!("写入版本数据失败: {}", e))?;
    let size = fs::metadata(&vpath)
        .map(|m| m.len())
        .unwrap_or(compressed.len() as u64);

    let meta = VersionMeta {
        id,
        time: now_ms(),
        label: payload.label,
        byte_count,
        size_bytes: size,
        hash,
    };
    metas.push(meta.clone());
    enforce_limits(&dir, &mut metas);
    write_meta(&dir, &metas)?;
    Ok(Some(meta))
}

/// 记录当前状态为一个版本；与最新版本内容相同时返回 None（跳过）
#[tauri::command]
pub async fn save_version(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    payload: SaveVersionPayload,
) -> Result<Option<VersionMeta>, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let opened = tab.file.clone();
    let (pieces, append_buf) = piece_snapshot(&tab);
    let lock = state.versions_lock.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        save_version_blocking(&app, &opened, pieces, append_buf, payload)
    });
    handle
        .await
        .map_err(|e| format!("记录版本任务失败: {}", e))?
}

/// 计算版本内容与当前显示内容的差异（预览构建临时覆盖层 / 恢复生成编辑操作共用）。
/// 阻塞线程内执行（需流式扫描 base.bin）。
fn load_version_diff_blocking(
    app: &AppHandle,
    opened: &OpenedFile,
    pieces: Vec<Piece>,
    append_buf: Vec<u8>,
    version_id: &str,
    edits: Vec<(u64, u8)>,
) -> Result<VersionDiff, String> {
    let dir = file_dir(app, &opened.path_string());
    let compressed = fs::read(version_file(&dir, version_id))
        .map_err(|_| "版本数据不存在或已删除".to_string())?;
    let json = zstd::bulk::decompress(&compressed, MAX_DECOMPRESS)
        .map_err(|e| format!("解压版本数据失败: {}", e))?;
    let data: VersionData =
        serde_json::from_slice(&json).map_err(|e| format!("解析版本数据失败: {}", e))?;

    let version_src = VersionSource {
        base: FileSource::open(&dir.join("base.bin"))?,
        overlay: data.overlay.iter().copied().collect(),
        structural: data.structural.clone(),
    };
    let mmap: &[u8] = opened.mmap_bytes().unwrap_or(&[]);
    let display = DisplaySource {
        mmap,
        pt: PieceTable::from_parts(pieces, append_buf),
        patch: edits.iter().copied().collect(),
    };
    // from = 当前显示内容，to = 版本内容
    match diff_sources(&display, &version_src)? {
        ContentDiff::Replaces(diffs) => Ok(VersionDiff {
            changes: diffs
                .into_iter()
                .map(|(offset, old_value, new_value)| VersionDiffChange { offset, old_value, new_value })
                .collect(),
            skipped: 0,
            structural: None,
        }),
        ContentDiff::Structural { prefix, from_mid_len, to_mid } => Ok(VersionDiff {
            changes: Vec::new(),
            skipped: 0,
            structural: Some(StructuralDiff {
                offset: prefix,
                delete_len: from_mid_len,
                insert_bytes: to_mid,
            }),
        }),
    }
}

/// 载入版本并计算与当前显示内容的差异
#[tauri::command]
pub async fn load_version_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    version_id: String,
    edits: Vec<(u64, u8)>,
) -> Result<VersionDiff, String> {
    let tab = state.get_tab(&tab_id).ok_or("尚未打开文件")?;
    let opened = tab.file.clone();
    let (pieces, append_buf) = piece_snapshot(&tab);
    let lock = state.versions_lock.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        load_version_diff_blocking(&app, &opened, pieces, append_buf, &version_id, edits)
    });
    handle
        .await
        .map_err(|e| format!("载入版本任务失败: {}", e))?
}

/// 版本列表（最新在前）
#[tauri::command]
pub fn list_versions(app: AppHandle, file_path: String) -> Result<Vec<VersionMeta>, String> {
    let dir = file_dir(&app, &file_path);
    let mut metas = read_meta(&dir);
    metas.reverse();
    Ok(metas)
}

/// 删除一个版本（不影响其他版本与当前编辑状态）
#[tauri::command]
pub fn delete_version(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    version_id: String,
) -> Result<(), String> {
    let _guard = state.versions_lock.lock().unwrap();
    let dir = file_dir(&app, &file_path);
    let mut metas = read_meta(&dir);
    if let Some(idx) = metas.iter().position(|m| m.id == version_id) {
        let m = metas.remove(idx);
        let _ = fs::remove_file(version_file(&dir, &m.id));
        // 最后一个版本删除后基线已无意义，一并清理（下次记录重建全新基线）
        if metas.is_empty() {
            let _ = fs::remove_file(dir.join("base.bin"));
            let _ = fs::remove_file(dir.join("meta.json"));
        } else {
            write_meta(&dir, &metas)?;
        }
    }
    Ok(())
}

/// 重命名版本标签
#[tauri::command]
pub fn rename_version(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    version_id: String,
    label: String,
) -> Result<(), String> {
    let _guard = state.versions_lock.lock().unwrap();
    let dir = file_dir(&app, &file_path);
    let mut metas = read_meta(&dir);
    match metas.iter_mut().find(|m| m.id == version_id) {
        Some(m) => {
            m.label = label;
            write_meta(&dir, &metas)
        }
        None => Err("版本不存在".into()),
    }
}

/// 清理旧版本：keepCount 保留最近 N 个 / keepDays 保留最近 N 天 / all 清理全部。
/// 返回删除的版本数。
#[tauri::command]
pub fn cleanup_versions(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    keep_count: Option<u32>,
    keep_days: Option<u32>,
    all: Option<bool>,
) -> Result<u32, String> {
    let _guard = state.versions_lock.lock().unwrap();
    let dir = file_dir(&app, &file_path);
    let metas = read_meta(&dir); // 存储顺序 = 时间顺序（最新在末尾）
    if metas.is_empty() {
        return Ok(0);
    }
    if all.unwrap_or(false) {
        let n = metas.len() as u32;
        fs::remove_dir_all(&dir).map_err(|e| format!("清理版本失败: {}", e))?;
        return Ok(n);
    }
    let mut keep: Vec<VersionMeta> = metas.clone();
    if let Some(n) = keep_count {
        let n = (n as usize).min(keep.len());
        keep = keep.split_off(keep.len() - n); // 保留最新 n 个
    } else if let Some(d) = keep_days {
        let cutoff = now_ms().saturating_sub(d as u64 * 86_400_000);
        keep.retain(|m| m.time >= cutoff);
    } else {
        return Err("未指定清理方式".into());
    }
    let mut deleted = 0u32;
    for m in &metas {
        if !keep.iter().any(|k| k.id == m.id) {
            let _ = fs::remove_file(version_file(&dir, &m.id));
            deleted += 1;
        }
    }
    if keep.is_empty() {
        let _ = fs::remove_file(dir.join("base.bin"));
        let _ = fs::remove_file(dir.join("meta.json"));
    } else {
        write_meta(&dir, &keep)?;
    }
    Ok(deleted)
}

/// 全局版本存储总大小（字节），前端据此在超过 2GB 时提示清理
#[tauri::command]
pub fn versions_global_size(app: AppHandle) -> Result<u64, String> {
    let root = versions_root(&app)?;
    if !root.is_dir() {
        return Ok(0);
    }
    Ok(dir_size(&root))
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(p) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(md) = entry.metadata() {
                total += md.len();
            }
        }
    }
    total
}
