# 项目代码量统计

- 扫描根目录：`d:\mp\hex-viewer`
- 扫描扩展名：.tsx, .ts, .css, .rs
- 统计口径：总行数 = 代码行 + 注释行 + 空行；注释行按常见语言注释符的启发式规则识别

## 按扩展名汇总

| 扩展名 | 文件数 | 总行数 | 代码行 | 注释行 | 空行 | 代码行占比 | 大小 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| .tsx (typescript) | 24 | 8,326 | 7,399 | 501 | 426 | 50.1% | 288.7 KB |
| .ts (typescript) | 21 | 3,499 | 2,762 | 422 | 315 | 18.7% | 115.0 KB |
| .css (css) | 1 | 2,828 | 2,331 | 103 | 394 | 15.8% | 50.0 KB |
| .rs (rust) | 6 | 2,658 | 2,270 | 230 | 158 | 15.4% | 89.7 KB |
| **总计** | **52** | **17,311** | **14,762** | **1,256** | **1,293** | **100.0%** | **543.4 KB** |

## 文件明细（按代码行数降序）

| 文件 | 语言 | 总行数 | 代码行 | 注释行 | 空行 | 大小 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| src/App.css | css | 2,828 | 2,331 | 103 | 394 | 50.0 KB |
| src/components/FileTab.tsx | typescript | 2,336 | 2,057 | 157 | 122 | 87.3 KB |
| src-tauri/src/lib.rs | rust | 1,467 | 1,279 | 111 | 77 | 48.3 KB |
| src/components/HexViewer.tsx | typescript | 794 | 680 | 73 | 41 | 28.5 KB |
| src-tauri/src/versions.rs | rust | 780 | 649 | 81 | 50 | 26.9 KB |
| src/App.tsx | typescript | 747 | 639 | 59 | 49 | 27.3 KB |
| src/components/SidebarAnalyze.tsx | typescript | 692 | 622 | 32 | 38 | 21.2 KB |
| src/components/SidebarAi.tsx | typescript | 544 | 491 | 21 | 32 | 18.5 KB |
| src/hooks/useFileEdits.ts | typescript | 581 | 470 | 70 | 41 | 20.3 KB |
| src/components/Toolbar.tsx | typescript | 475 | 444 | 16 | 15 | 15.5 KB |
| src/components/SidebarVersions.tsx | typescript | 328 | 305 | 10 | 13 | 10.8 KB |
| src/components/Sidebar.tsx | typescript | 311 | 281 | 24 | 6 | 9.9 KB |
| src/components/SidebarEdit.tsx | typescript | 304 | 277 | 20 | 7 | 10.4 KB |
| src/components/DiffTab.tsx | typescript | 293 | 253 | 24 | 16 | 10.4 KB |
| src/utils/decode.ts | typescript | 298 | 233 | 46 | 19 | 10.1 KB |
| src/hooks/useFileVersions.ts | typescript | 292 | 230 | 39 | 23 | 9.8 KB |
| src-tauri/src/edit.rs | rust | 270 | 227 | 23 | 20 | 9.3 KB |
| src/hooks/useFileWindow.ts | typescript | 281 | 222 | 40 | 19 | 10.1 KB |
| src/utils/inspect.ts | typescript | 266 | 221 | 21 | 24 | 9.4 KB |
| src/components/SidebarBookmarks.tsx | typescript | 216 | 204 | 5 | 7 | 6.3 KB |
| src/components/InsertDialog.tsx | typescript | 215 | 194 | 10 | 11 | 7.8 KB |
| src/types.ts | typescript | 251 | 181 | 39 | 31 | 5.9 KB |
| src/components/StatusBar.tsx | typescript | 150 | 141 | 2 | 7 | 4.8 KB |
| src/utils/aiClient.ts | typescript | 168 | 141 | 15 | 12 | 5.5 KB |
| src/hooks/useAiChat.ts | typescript | 184 | 135 | 30 | 19 | 6.3 KB |
| src/hooks/useDisplayConfig.ts | typescript | 149 | 129 | 2 | 18 | 4.6 KB |
| src/hooks/useFileBookmarks.ts | typescript | 165 | 128 | 16 | 21 | 5.0 KB |
| src/utils/hexParse.ts | typescript | 164 | 123 | 29 | 12 | 5.7 KB |
| src/hooks/useFileSearch.ts | typescript | 127 | 112 | 6 | 9 | 3.5 KB |
| src/components/EditDialog.tsx | typescript | 124 | 110 | 5 | 9 | 4.3 KB |
| src-tauri/src/autosave.rs | rust | 132 | 108 | 14 | 10 | 5.0 KB |
| src/components/FillDialog.tsx | typescript | 116 | 105 | 3 | 8 | 3.6 KB |
| src/components/DataInspector.tsx | typescript | 118 | 100 | 9 | 9 | 3.5 KB |
| src/components/CommandPalette.tsx | typescript | 109 | 92 | 8 | 9 | 3.2 KB |
| src/components/ContextMenu.tsx | typescript | 101 | 86 | 8 | 7 | 3.1 KB |
| src/components/SidebarInfo.tsx | typescript | 93 | 86 | 2 | 5 | 3.6 KB |
| src/hooks/useAiConfig.ts | typescript | 104 | 80 | 10 | 14 | 3.6 KB |
| src/components/SidebarPerf.tsx | typescript | 75 | 69 | 3 | 3 | 2.5 KB |
| src/hooks/useRecentFiles.ts | typescript | 85 | 67 | 7 | 11 | 2.3 KB |
| src/hooks/useFileStats.ts | typescript | 74 | 63 | 5 | 6 | 2.5 KB |
| src/components/SidebarSearch.tsx | typescript | 64 | 60 | 1 | 3 | 2.4 KB |
| src/utils/aiContext.ts | typescript | 83 | 57 | 17 | 9 | 3.0 KB |
| src/components/TabBar.tsx | typescript | 67 | 56 | 7 | 4 | 2.0 KB |
| src/utils/format.ts | typescript | 73 | 54 | 7 | 12 | 2.7 KB |
| src/hooks/usePerfMonitor.ts | typescript | 64 | 47 | 8 | 9 | 1.8 KB |
| src/hooks/useStringExtract.ts | typescript | 57 | 47 | 6 | 4 | 1.9 KB |
| src/components/ConfirmDialog.tsx | typescript | 45 | 39 | 2 | 4 | 1.3 KB |
| vite.config.ts | typescript | 32 | 22 | 8 | 2 | 891 B |
| src/main.tsx | typescript | 9 | 8 | 0 | 1 | 238 B |
| src-tauri/src/main.rs | rust | 6 | 4 | 1 | 1 | 191 B |
| src-tauri/build.rs | rust | 3 | 3 | 0 | 0 | 42 B |
| src/vite-env.d.ts | typescript | 1 | 0 | 1 | 0 | 39 B |

