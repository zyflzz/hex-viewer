// 崩溃恢复（v1.1.4）：
// 每次编辑后前端防抖 2 秒，把操作列表快照 + 撤销位置 + 光标/选择写盘：
//   <app_data>/hex-viewer/autosave/<sha256(path)[0..16]>.json.zst
// 保存成功 / 放弃修改 / 关闭标签时删除；打开文件时检测并询问是否恢复。
// 容量控制：最多 32 个文件（超出淘汰最旧）；单文件 payload 超过 50MB 放弃并报错。
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// 保留的 autosave 文件数上限（超出按修改时间淘汰最旧）
const MAX_AUTOSAVE_FILES: usize = 32;
/// 单个 payload（序列化后 JSON）的大小上限
const MAX_PAYLOAD_BYTES: usize = 50 * 1024 * 1024;
/// 解压防御上限
const MAX_DECOMPRESS: usize = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveInfo {
    /// 写盘时间（unix 毫秒）
    pub time: u64,
    /// 前端状态快照（操作列表 / 撤销位置 / 光标 / 选择），Rust 不解释
    pub payload: Value,
}

fn file_id(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..16].to_string()
}

fn autosave_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    Ok(dir.join("hex-viewer").join("autosave"))
}

fn autosave_file(app: &AppHandle, file_path: &str) -> Result<PathBuf, String> {
    Ok(autosave_dir(app)?.join(format!("{}.json.zst", file_id(file_path))))
}

/// 淘汰超出上限的最旧 autosave（按文件修改时间）
fn enforce_limits(app: &AppHandle) {
    let dir = match autosave_dir(app) {
        Ok(d) => d,
        Err(_) => return,
    };
    let entries: Vec<(PathBuf, u64)> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "zst").unwrap_or(false))
            .filter_map(|e| {
                let mtime = e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some((e.path(), mtime))
            })
            .collect(),
        Err(_) => return,
    };
    if entries.len() < MAX_AUTOSAVE_FILES {
        return;
    }
    let mut sorted = entries;
    sorted.sort_by_key(|&(_, t)| t);
    let excess = sorted.len() + 1 - MAX_AUTOSAVE_FILES;
    for (path, _) in sorted.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// 写入 autosave（payload 为前端状态快照）
#[tauri::command]
pub fn save_autosave(app: AppHandle, file_path: String, payload: Value) -> Result<(), String> {
    let json = serde_json::to_vec(&payload)
        .map_err(|e| format!("序列化自动保存数据失败: {}", e))?;
    if json.len() > MAX_PAYLOAD_BYTES {
        return Err("自动保存内容过大（超过 50MB），已暂停，请及时手动保存".into());
    }
    let target = autosave_file(&app, &file_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建自动保存目录失败: {}", e))?;
    }
    let compressed = zstd::encode_all(&json[..], 3)
        .map_err(|e| format!("压缩自动保存数据失败: {}", e))?;
    let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, &compressed).map_err(|e| format!("写入自动保存数据失败: {}", e))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换自动保存数据失败: {}", e));
    }
    enforce_limits(&app);
    Ok(())
}

/// 读取 autosave（不存在或损坏返回 None）
#[tauri::command]
pub fn load_autosave(app: AppHandle, file_path: String) -> Result<Option<AutosaveInfo>, String> {
    let target = autosave_file(&app, &file_path)?;
    let compressed = match fs::read(&target) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let json = zstd::bulk::decompress(&compressed, MAX_DECOMPRESS)
        .map_err(|e| format!("解压自动保存数据失败: {}", e))?;
    let info: AutosaveInfo = serde_json::from_slice(&json)
        .map_err(|e| format!("解析自动保存数据失败: {}", e))?;
    Ok(Some(info))
}

/// 删除 autosave（保存成功 / 放弃修改 / 关闭标签时调用）
#[tauri::command]
pub fn clear_autosave(app: AppHandle, file_path: String) -> Result<(), String> {
    let target = autosave_file(&app, &file_path)?;
    match fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除自动保存数据失败: {}", e)),
    }
}
