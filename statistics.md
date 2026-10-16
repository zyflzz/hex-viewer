# 项目代码量统计

- 扫描根目录：`D:\mp\hex-viewer`
- 扫描扩展名：.tsx, .ts, .css, .rs
- 统计口径：总行数 = 代码行 + 注释行 + 空行；注释行按常见语言注释符的启发式规则识别

## 按扩展名汇总

| 扩展名 | 文件数 | 总行数 | 代码行 | 注释行 | 空行 | 代码行占比 | 大小 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| .tsx (typescript) | 21 | 6,576 | 5,860 | 375 | 341 | 49.1% | 225.6 KB |
| .ts (typescript) | 21 | 3,000 | 2,350 | 368 | 282 | 19.7% | 98.5 KB |
| .css (css) | 1 | 2,647 | 2,182 | 97 | 368 | 18.3% | 46.7 KB |
| .rs (rust) | 4 | 1,790 | 1,533 | 151 | 106 | 12.9% | 57.5 KB |
| **总计** | **47** | **14,013** | **11,925** | **991** | **1,097** | **100.0%** | **428.3 KB** |

## 文件明细（按代码行数降序）

| 文件 | 语言 | 总行数 | 代码行 | 注释行 | 空行 | 大小 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| src/App.css | css | 2,647 | 2,182 | 97 | 368 | 46.7 KB |
| src/components/FileTab.tsx | typescript | 1,828 | 1,605 | 122 | 101 | 66.9 KB |
| src-tauri/src/lib.rs | rust | 1,209 | 1,057 | 88 | 64 | 38.0 KB |
| src/components/HexViewer.tsx | typescript | 783 | 674 | 68 | 41 | 28.0 KB |
| src/components/SidebarAi.tsx | typescript | 544 | 491 | 21 | 32 | 18.5 KB |
| src-tauri/src/versions.rs | rust | 572 | 469 | 62 | 41 | 19.3 KB |
| src/components/Toolbar.tsx | typescript | 461 | 432 | 14 | 15 | 15.0 KB |
| src/App.tsx | typescript | 502 | 422 | 43 | 37 | 18.5 KB |
| src/components/SidebarAnalyze.tsx | typescript | 406 | 368 | 16 | 22 | 12.3 KB |
| src/components/SidebarVersions.tsx | typescript | 328 | 305 | 10 | 13 | 10.8 KB |
| src/components/Sidebar.tsx | typescript | 294 | 268 | 20 | 6 | 9.3 KB |
| src/components/SidebarEdit.tsx | typescript | 255 | 233 | 15 | 7 | 8.6 KB |
| src/utils/decode.ts | typescript | 298 | 233 | 46 | 19 | 10.1 KB |
| src/utils/inspect.ts | typescript | 266 | 221 | 21 | 24 | 9.4 KB |
| src/hooks/useFileWindow.ts | typescript | 256 | 207 | 32 | 17 | 9.1 KB |
| src/components/SidebarBookmarks.tsx | typescript | 216 | 204 | 5 | 7 | 6.3 KB |
| src/hooks/useFileEdits.ts | typescript | 260 | 195 | 44 | 21 | 8.9 KB |
| src/hooks/useFileVersions.ts | typescript | 240 | 186 | 32 | 22 | 8.0 KB |
| src/components/StatusBar.tsx | typescript | 150 | 141 | 2 | 7 | 4.8 KB |
| src/utils/aiClient.ts | typescript | 168 | 141 | 15 | 12 | 5.5 KB |
| src/hooks/useAiChat.ts | typescript | 184 | 135 | 30 | 19 | 6.3 KB |
| src/hooks/useDisplayConfig.ts | typescript | 149 | 129 | 2 | 18 | 4.6 KB |
| src/hooks/useFileBookmarks.ts | typescript | 165 | 128 | 16 | 21 | 5.0 KB |
| src/utils/hexParse.ts | typescript | 164 | 123 | 29 | 12 | 5.7 KB |
| src/hooks/useFileSearch.ts | typescript | 127 | 112 | 6 | 9 | 3.5 KB |
| src/components/EditDialog.tsx | typescript | 124 | 110 | 5 | 9 | 4.3 KB |
| src/types.ts | typescript | 156 | 109 | 26 | 21 | 3.6 KB |
| src/components/FillDialog.tsx | typescript | 116 | 105 | 3 | 8 | 3.6 KB |
| src/components/DataInspector.tsx | typescript | 118 | 100 | 9 | 9 | 3.5 KB |
| src/components/ContextMenu.tsx | typescript | 101 | 86 | 8 | 7 | 3.1 KB |
| src/components/SidebarInfo.tsx | typescript | 93 | 86 | 2 | 5 | 3.6 KB |
| src/hooks/useAiConfig.ts | typescript | 104 | 80 | 10 | 14 | 3.6 KB |
| src/components/SidebarPerf.tsx | typescript | 75 | 69 | 3 | 3 | 2.5 KB |
| src/hooks/useRecentFiles.ts | typescript | 85 | 67 | 7 | 11 | 2.3 KB |
| src/components/SidebarSearch.tsx | typescript | 64 | 60 | 1 | 3 | 2.4 KB |
| src/hooks/useFileStats.ts | typescript | 68 | 57 | 5 | 6 | 2.5 KB |
| src/utils/aiContext.ts | typescript | 83 | 57 | 17 | 9 | 3.0 KB |
| src/components/TabBar.tsx | typescript | 64 | 54 | 6 | 4 | 1.8 KB |
| src/utils/format.ts | typescript | 73 | 54 | 7 | 12 | 2.7 KB |
| src/hooks/usePerfMonitor.ts | typescript | 64 | 47 | 8 | 9 | 1.8 KB |
| src/hooks/useStringExtract.ts | typescript | 57 | 47 | 6 | 4 | 1.9 KB |
| src/components/ConfirmDialog.tsx | typescript | 45 | 39 | 2 | 4 | 1.3 KB |
| vite.config.ts | typescript | 32 | 22 | 8 | 2 | 891 B |
| src/main.tsx | typescript | 9 | 8 | 0 | 1 | 238 B |
| src-tauri/src/main.rs | rust | 6 | 4 | 1 | 1 | 191 B |
| src-tauri/build.rs | rust | 3 | 3 | 0 | 0 | 42 B |
| src/vite-env.d.ts | typescript | 1 | 0 | 1 | 0 | 39 B |

