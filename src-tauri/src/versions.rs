// 历史版本存储（v1.0.2.003）：
// 每个文件一个目录 <app_data>/hex-viewer/versions/<sha256(path)[0..16]>/：
// - base.bin         基线快照（首次记录版本时从当前 mmap 全量拷贝，所有版本共享）
// - meta.json        版本索引（不含 ops / overlay），存储顺序 = 时间顺序（最新在末尾）
// - v<id>.json.zst   单版本完整数据（ops 快照 + pos + overlay），zstd 压缩
//
// overlay 语义：相对 base.bin 的完整差异，版本内容 = base + overlay。
// 各版本互相独立（不引用其他版本），删除任一版本不影响其余版本的恢复。
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::{AppState, OpenedFile};

/// 每个文件最多保留的版本数（超出删最旧）
const MAX_VERSIONS_PER_FILE: usize = 50;
/// 每个文件的版本数据（v 文件合计，不含 base.bin）大小上限
const MAX_VERSION_DATA_BYTES: u64 = 200 * 1024 * 1024;
/// 基线扫描缓冲区大小
const SCAN_BUF: usize = 8 * 1024 * 1024;
/// 解压版本数据的容量上限（防御异常数据）
const MAX_DECOMPRESS: usize = 512 * 1024 * 1024;

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

/// 单个版本的完整数据（磁盘格式）
#[derive(Serialize, Deserialize)]
struct VersionData {
    ops: Value,
    pos: u64,
    /// 相对 base.bin 的覆盖层 [offset, value]
    overlay: Vec<(u64, u8)>,
}

/// 版本内容与当前显示内容的差异（恢复/预览共用）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiffChange {
    pub offset: u64,
    /// 当前显示值（未保存覆盖层 ?? 磁盘值）
    pub old_value: u8,
    /// 版本内容值
    pub new_value: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDiff {
    pub changes: Vec<VersionDiffChange>,
    /// 因超出当前文件大小而跳过的偏移数
    pub skipped: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct MetaFile {
    versions: Vec<VersionMeta>,
}

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

/// 读取版本索引；缺失/损坏视为空（下一次写入会重建）
fn read_meta(dir: &Path) -> Vec<VersionMeta> {
    fs::read(dir.join("meta.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<MetaFile>(&b).ok())
        .map(|m| m.versions)
        .unwrap_or_default()
}

/// 原子写版本索引（临时文件 + rename，避免崩溃留下半成品）
fn write_meta(dir: &Path, metas: &[VersionMeta]) -> Result<(), String> {
    let json = serde_json::to_vec(&MetaFile {
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

/// 基线扫描结果
struct BaseScan {
    /// base 与 mmap 不同的位置：(offset, base 字节, mmap 字节)
    diffs: Vec<(u64, u8, u8)>,
    /// 需要关注的位置（wanted ∪ diffs）的 base 字节
    base_at: HashMap<u64, u8>,
    base_len: u64,
}

/// 流式扫描 base.bin 与当前 mmap 的差异（内存占用恒定：SCAN_BUF）。
/// 同时捕获 wanted 集合中各偏移的 base 字节（含超出 mmap 长度的部分）。
fn scan_base(base_path: &Path, mmap: &[u8], wanted: &HashSet<u64>) -> Result<BaseScan, String> {
    let mut f =
        fs::File::open(base_path).map_err(|e| format!("无法读取基线快照: {}", e))?;
    let mut buf = vec![0u8; SCAN_BUF];
    let mut scan = BaseScan {
        diffs: Vec::new(),
        base_at: HashMap::new(),
        base_len: 0,
    };
    let mut pos: u64 = 0;
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读取基线快照失败: {}", e))?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        let m_start = pos as usize;
        let m_end = ((pos + n as u64) as usize).min(mmap.len());
        // base 与 mmap 的重叠区间（base 比 mmap 长时 saturating 到 0，只查 wanted）
        let overlap = m_end.saturating_sub(m_start);
        for i in 0..overlap {
            let o = pos + i as u64;
            let b = chunk[i];
            if b != mmap[m_start + i] {
                scan.diffs.push((o, b, mmap[m_start + i]));
                scan.base_at.insert(o, b);
            } else if wanted.contains(&o) {
                scan.base_at.insert(o, b);
            }
        }
        // wanted 中超出 mmap 长度但仍处于 base 范围内的偏移
        for i in overlap..n {
            let o = pos + i as u64;
            if wanted.contains(&o) {
                scan.base_at.insert(o, chunk[i]);
            }
        }
        pos += n as u64;
    }
    scan.base_len = pos;
    Ok(scan)
}

/// 校验文件已打开且路径匹配；返回其句柄
fn require_opened(state: &State<'_, AppState>, file_path: &str) -> Result<Arc<OpenedFile>, String> {
    let opened = state
        .file
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未打开文件")?;
    if !opened.matches_path(file_path) {
        return Err("文件路径与当前打开的文件不一致".into());
    }
    Ok(opened)
}

/// 记录版本的核心流程（阻塞线程内执行）：
/// 1. 确保 base.bin 存在（首次记录 = 当前 mmap 全量拷贝）
/// 2. overlay = 显示内容相对 base 的完整差异（磁盘漂移 + 未保存编辑合并）
/// 3. 与最新版本内容指纹相同则跳过（返回 None）
/// 4. 写 v<id>.json.zst，更新 meta.json，执行容量清理
fn save_version_blocking(
    app: &AppHandle,
    opened: &OpenedFile,
    payload: SaveVersionPayload,
) -> Result<Option<VersionMeta>, String> {
    let mmap = opened
        .mmap_bytes()
        .ok_or("文件为空，无法记录版本")?;
    let dir = file_dir(app, &opened.path_string());
    fs::create_dir_all(&dir).map_err(|e| format!("创建版本目录失败: {}", e))?;
    let base_path = dir.join("base.bin");
    if !base_path.is_file() {
        fs::write(&base_path, mmap).map_err(|e| format!("写入基线快照失败: {}", e))?;
    }

    // 未保存编辑（相对磁盘）→ 需要其偏移的 base 字节
    let edits: BTreeMap<u64, u8> = payload.edits.into_iter().collect();
    let wanted: HashSet<u64> = edits.keys().copied().collect();
    let scan = scan_base(&base_path, mmap, &wanted)?;

    // 版本 overlay = base 起的全部差异：
    // - 磁盘相对 base 的漂移（已保存的修改）取 mmap 当前值
    // - 未保存编辑覆盖其上；与 base 相同的偏移不进 overlay
    let mut overlay: BTreeMap<u64, u8> = BTreeMap::new();
    for (o, _base_b, mmap_b) in &scan.diffs {
        overlay.insert(*o, *mmap_b);
    }
    for (o, v) in &edits {
        match scan.base_at.get(o) {
            Some(&b) => {
                if *v != b {
                    overlay.insert(*o, *v);
                } else {
                    overlay.remove(o);
                }
            }
            None => {
                // 偏移超出 base 长度（文件曾增长）：尽力保留显示值
                overlay.insert(*o, *v);
            }
        }
    }

    let data = VersionData {
        ops: payload.ops,
        pos: payload.pos,
        overlay: overlay.into_iter().collect(),
    };
    // 内容指纹：ops + pos + overlay（不含 label/time，纯内容比对）
    let hash = {
        let mut h = Sha256::new();
        h.update(
            &serde_json::to_vec(&data.ops).unwrap_or_default(),
        );
        h.update(&data.pos.to_le_bytes());
        for (o, v) in &data.overlay {
            h.update(&o.to_le_bytes());
            h.update(&[*v]);
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
        byte_count: data.overlay.len() as u64,
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
    file_path: String,
    payload: SaveVersionPayload,
) -> Result<Option<VersionMeta>, String> {
    let opened = require_opened(&state, &file_path)?;
    if opened.mmap_bytes().is_none() {
        return Err("文件为空，无法记录版本".into());
    }
    let lock = state.versions_lock.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        save_version_blocking(&app, &opened, payload)
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
    version_id: &str,
    edits: Vec<(u64, u8)>,
) -> Result<VersionDiff, String> {
    let mmap = opened
        .mmap_bytes()
        .ok_or("文件为空")?;
    let dir = file_dir(app, &opened.path_string());
    let compressed = fs::read(version_file(&dir, version_id))
        .map_err(|_| "版本数据不存在或已删除".to_string())?;
    let json = zstd::bulk::decompress(&compressed, MAX_DECOMPRESS)
        .map_err(|e| format!("解压版本数据失败: {}", e))?;
    let data: VersionData =
        serde_json::from_slice(&json).map_err(|e| format!("解析版本数据失败: {}", e))?;

    let vmap: BTreeMap<u64, u8> = data.overlay.into_iter().collect();
    let emap: BTreeMap<u64, u8> = edits.into_iter().collect();
    let mut wanted: HashSet<u64> = vmap.keys().copied().collect();
    wanted.extend(emap.keys().copied());
    let scan = scan_base(&dir.join("base.bin"), mmap, &wanted)?;

    // 候选偏移 = 磁盘漂移 ∪ 版本 overlay ∪ 当前未保存编辑
    let mut offsets: BTreeSet<u64> = scan.diffs.iter().map(|d| d.0).collect();
    offsets.extend(vmap.keys());
    offsets.extend(emap.keys());

    let mut changes = Vec::new();
    let mut skipped: u64 = 0;
    for o in offsets {
        if o >= mmap.len() as u64 {
            skipped += 1; // 版本内容位置超出当前文件（文件曾被截断），跳过
            continue;
        }
        let cur = emap.get(&o).copied().unwrap_or(mmap[o as usize]);
        let target = match vmap.get(&o) {
            Some(&v) => v,
            None => match scan.base_at.get(&o) {
                Some(&b) => b,
                None => continue, // 超出 base 长度且版本未覆盖：无定义，跳过
            },
        };
        if cur != target {
            changes.push(VersionDiffChange {
                offset: o,
                old_value: cur,
                new_value: target,
            });
        }
    }
    Ok(VersionDiff { changes, skipped })
}

/// 载入版本并计算与当前显示内容的差异
#[tauri::command]
pub async fn load_version_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    version_id: String,
    edits: Vec<(u64, u8)>,
) -> Result<VersionDiff, String> {
    let opened = require_opened(&state, &file_path)?;
    let lock = state.versions_lock.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        load_version_diff_blocking(&app, &opened, &version_id, edits)
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
