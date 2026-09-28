// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init()) // 注册对话框插件
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_file, greet]) // 一次注册所有命令
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}