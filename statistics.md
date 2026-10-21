# 项目代码量统计

- 扫描根目录：`d:\mp\hex-viewer`
- 扫描扩展名：.tsx, .ts, .css, .rs
- 统计口径：总行数 = 代码行 + 注释行 + 空行；注释行按常见语言注释符的启发式规则识别

## 按扩展名汇总

| 扩展名 | 文件数 | 总行数 | 代码行 | 注释行 | 空行 | 代码行占比 | 大小 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| .tsx (typescript) | 27 | 9,582 | 8,547 | 567 | 468 | 50.3% | 337.4 KB |
| .ts (typescript) | 25 | 4,242 | 3,365 | 504 | 373 | 19.8% | 139.8 KB |
| .css (css) | 1 | 3,091 | 2,548 | 109 | 434 | 15.0% | 54.1 KB |
| .rs (rust) | 6 | 2,963 | 2,521 | 271 | 171 | 14.8% | 101.5 KB |
| **总计** | **59** | **19,878** | **16,981** | **1,451** | **1,446** | **100.0%** | **632.8 KB** |

## 文件明细（按代码行数降序）

| 文件 | 语言 | 总行数 | 代码行 | 注释行 | 空行 | 大小 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| src/App.css | css | 3,091 | 2,548 | 109 | 434 | 54.1 KB |
| src/components/FileTab.tsx | typescript | 2,723 | 2,407 | 182 | 134 | 103.5 KB |
| src-tauri/src/lib.rs | rust | 1,772 | 1,530 | 152 | 90 | 60.2 KB |
| src/components/HexViewer.tsx | typescript | 895 | 768 | 86 | 41 | 32.9 KB |
| src-tauri/src/versions.rs | rust | 780 | 649 | 81 | 50 | 26.9 KB |
| src/App.tsx | typescript | 753 | 645 | 59 | 49 | 27.5 KB |
| src/components/SidebarAnalyze.tsx | typescript | 700 | 628 | 34 | 38 | 21.7 KB |
| src/components/SidebarAi.tsx | typescript | 560 | 505 | 23 | 32 | 19.1 KB |
| src/hooks/useFileEdits.ts | typescript | 581 | 470 | 70 | 41 | 20.3 KB |
| src/components/Toolbar.tsx | typescript | 475 | 444 | 16 | 15 | 15.5 KB |
| src/components/AiTemplateDialog.tsx | typescript | 396 | 364 | 11 | 21 | 14.1 KB |
| src/components/SidebarEdit.tsx | typescript | 374 | 343 | 24 | 7 | 13.1 KB |
| src/components/SidebarVersions.tsx | typescript | 328 | 305 | 10 | 13 | 10.8 KB |
| src/components/Sidebar.tsx | typescript | 334 | 302 | 26 | 6 | 10.7 KB |
| src/components/DiffTab.tsx | typescript | 293 | 253 | 24 | 16 | 10.4 KB |
| src/utils/decode.ts | typescript | 298 | 233 | 46 | 19 | 10.1 KB |
| src/types.ts | typescript | 328 | 232 | 56 | 40 | 8.0 KB |
| src/hooks/useFileVersions.ts | typescript | 292 | 230 | 39 | 23 | 9.8 KB |
| src/components/SidebarBookmarks.tsx | typescript | 242 | 228 | 6 | 8 | 7.2 KB |
| src-tauri/src/edit.rs | rust | 270 | 227 | 23 | 20 | 9.3 KB |
| src/hooks/useFileWindow.ts | typescript | 281 | 222 | 40 | 19 | 10.1 KB |
| src/utils/inspect.ts | typescript | 266 | 221 | 21 | 24 | 9.4 KB |
| src/utils/templateParser.ts | typescript | 233 | 203 | 17 | 13 | 8.3 KB |
| src/components/InsertDialog.tsx | typescript | 215 | 194 | 10 | 11 | 7.8 KB |
| src/hooks/useDisplayConfig.ts | typescript | 178 | 155 | 2 | 21 | 5.6 KB |
| src/components/StatusBar.tsx | typescript | 156 | 146 | 3 | 7 | 5.1 KB |
| src/hooks/useFileBookmarks.ts | typescript | 188 | 146 | 20 | 22 | 5.6 KB |
| src/utils/aiClient.ts | typescript | 168 | 141 | 15 | 12 | 5.5 KB |
| src/hooks/useAiChat.ts | typescript | 184 | 135 | 30 | 19 | 6.3 KB |
| src/components/ExportChatDialog.tsx | typescript | 128 | 123 | 1 | 4 | 4.7 KB |
| src/utils/hexParse.ts | typescript | 164 | 123 | 29 | 12 | 5.7 KB |
| src/hooks/useFileSearch.ts | typescript | 127 | 112 | 6 | 9 | 3.5 KB |
| src/components/FillDialog.tsx | typescript | 124 | 111 | 5 | 8 | 3.9 KB |
| src/components/EditDialog.tsx | typescript | 124 | 110 | 5 | 9 | 4.3 KB |
| src/hooks/useFileTemplates.ts | typescript | 129 | 109 | 9 | 11 | 3.8 KB |
| src-tauri/src/autosave.rs | rust | 132 | 108 | 14 | 10 | 5.0 KB |
| src/utils/selection.ts | typescript | 137 | 103 | 22 | 12 | 5.1 KB |
| src/components/DataInspector.tsx | typescript | 118 | 100 | 9 | 9 | 3.5 KB |
| src/utils/chatExport.ts | typescript | 115 | 93 | 13 | 9 | 3.9 KB |
| src/components/CommandPalette.tsx | typescript | 109 | 92 | 8 | 9 | 3.2 KB |
| src/components/ContextMenu.tsx | typescript | 101 | 86 | 8 | 7 | 3.1 KB |
| src/components/SidebarInfo.tsx | typescript | 93 | 86 | 2 | 5 | 3.6 KB |
| src/hooks/useAiConfig.ts | typescript | 104 | 80 | 10 | 14 | 3.6 KB |
| src/components/BackupRestoreDialog.tsx | typescript | 81 | 75 | 2 | 4 | 3.0 KB |
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

