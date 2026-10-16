import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Toolbar } from './components/Toolbar';
import { TabBar, type TabBarItem } from './components/TabBar';
import { FileTab, type FileTabHandle } from './components/FileTab';
import { ConfirmDialog } from './components/ConfirmDialog';
import { useDisplayConfig } from './hooks/useDisplayConfig';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useAiConfig } from './hooks/useAiConfig';
import type { SearchMode } from './hooks/useFileSearch';
import type { FileTabStatus, TabInfo } from './types';
import { validateReplace } from './utils/hexParse';
import './App.css';

/**
 * 应用外壳：工具栏（全局输入态）+ 标签栏 + 各文件标签页。
 * 单文件的全部交互逻辑下沉到 FileTab（未激活标签 display:none 保留状态），
 * 全局快捷键与工具栏动作经 FileTabHandle 转发到激活标签页。
 */
function App() {
  const {
    config,
    setBytesPerRow,
    zoomFont,
    setTheme,
    toggleAscii,
    setEncoding,
    setEditMode,
    setConfirmSave,
    setVersionMode,
    setByteGrouping,
    setRowHighlight,
    setColHighlight,
  } = useDisplayConfig();
  const ai = useAiConfig();
  const { recentFiles, addRecent, removeRecent, clearRecent } = useRecentFiles();

  // ---------- 标签页管理 ----------

  const [tabState, setTabState] = useState<{ tabs: TabInfo[]; activeId: string | null }>({
    tabs: [],
    activeId: null,
  });
  /** 各标签页上报的状态（文件名 / 编辑数 / 搜索进度 / 命中数 / 预览态） */
  const [tabStatus, setTabStatus] = useState<Map<string, FileTabStatus>>(new Map());
  const tabHandles = useRef(new Map<string, FileTabHandle>());

  // latest-ref：供事件回调 / 异步流程读取最新值而不重建闭包
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  const activeIdRef = useRef<string | null>(tabState.activeId);
  activeIdRef.current = tabState.activeId;

  /** 取激活标签页的命令通道（事件时刻读取，避免渲染期 ref 未挂载的空档） */
  const getActiveHandle = useCallback((): FileTabHandle | null => {
    const id = activeIdRef.current;
    return id ? tabHandles.current.get(id) ?? null : null;
  }, []);

  // ---------- Toast（仅激活标签页展示） ----------

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ---------- 工具栏输入态（跨标签页共享） ----------

  const searchInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>('text');
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [gotoText, setGotoText] = useState('');
  const [replaceText, setReplaceText] = useState('');

  /** 替换内容等长校验（与 FileTab 替换执行共用同一套规则） */
  const { ok: replaceOk, hint: replaceHint } = useMemo(
    () => validateReplace(searchMode, searchText, replaceText),
    [searchMode, searchText, replaceText],
  );

  // ---------- 拖拽 / 关闭确认 ----------

  const [dragActive, setDragActive] = useState(false);
  /** 待确认关闭的标签页（有未保存修改时三选一） */
  const [closeConfirmTabId, setCloseConfirmTabId] = useState<string | null>(null);

  // ---------- 打开 / 关闭 ----------

  /** 正在预打开的路径（防止同一路径快速触发两次产生重复标签） */
  const openingPathsRef = useRef(new Set<string>());
  const idSeqRef = useRef(0);

  /** 打开文件为新标签页：同文件已开则切换；预 invoke 校验失败不产生标签 */
  const openNewTab = useCallback(
    async (path: string) => {
      // 同文件不允许双开：切到已有标签
      const existing = tabStateRef.current.tabs.find(t => t.path === path);
      if (existing) {
        setTabState(s => ({ ...s, activeId: existing.id }));
        showToast('文件已打开');
        return;
      }
      if (openingPathsRef.current.has(path)) return;
      openingPathsRef.current.add(path);
      const tabId = `tab-${Date.now().toString(36)}-${(idSeqRef.current++).toString(36)}`;
      try {
        // 预打开校验（文件不存在等失败直接提示，不产生标签页）；
        // FileTab 挂载后会以同 tabId 再次 open_file（替换句柄，无害）
        await invoke('open_file', { path, tabId });
      } catch (err) {
        openingPathsRef.current.delete(path);
        removeRecent(path);
        const known = recentFiles.some(f => f.path === path);
        showToast(
          known ? `文件已不存在，已从最近列表移除（${err}）` : `打开文件失败: ${err}`,
        );
        console.error(err);
        return;
      }
      openingPathsRef.current.delete(path);
      addRecent(path);
      setTabState(s => ({ tabs: [...s.tabs, { id: tabId, path }], activeId: tabId }));
    },
    [showToast, removeRecent, addRecent, recentFiles],
  );

  /** 实际关闭标签页：通知后端释放句柄（同时取消在途扫描），切到相邻标签（优先左侧） */
  const doCloseTab = useCallback((tabId: string) => {
    invoke('close_tab', { tabId }).catch(() => {});
    setTabState(({ tabs, activeId }) => {
      const idx = tabs.findIndex(t => t.id === tabId);
      if (idx < 0) return { tabs, activeId };
      const nextTabs = tabs.filter(t => t.id !== tabId);
      const nextActive =
        activeId === tabId
          ? nextTabs.length
            ? nextTabs[Math.min(idx, nextTabs.length - 1)].id
            : null
          : activeId;
      return { tabs: nextTabs, activeId: nextActive };
    });
    setTabStatus(prev => {
      if (!prev.has(tabId)) return prev;
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  /** 请求关闭标签页：有未保存修改先弹三选一确认 */
  const requestCloseTab = useCallback(
    (tabId: string) => {
      const st = tabStatus.get(tabId);
      if (st && st.editCount > 0) {
        setCloseConfirmTabId(tabId);
        return;
      }
      doCloseTab(tabId);
    },
    [tabStatus, doCloseTab],
  );

  /** FileTab 打开失败（预校验后文件又被删除等）：清理并提示 */
  const handleOpenFailed = useCallback(
    (tabId: string, path: string, err: string) => {
      removeRecent(path);
      showToast(`打开文件失败: ${err}`);
      doCloseTab(tabId);
    },
    [removeRecent, showToast, doCloseTab],
  );

  /** 系统文件选择框（工具栏"打开文件" / 标签栏"+"共用） */
  const handleOpenFile = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      });
      if (!selected) return;
      void openNewTab(selected as string);
    } catch (err) {
      showToast(`打开文件失败: ${err}`);
      console.error(err);
    }
  }, [openNewTab, showToast]);

  /** 右键菜单"跳转到此偏移"：填充跳转输入框并聚焦 */
  const handleGotoFill = useCallback((text: string) => {
    setGotoText(text);
    gotoInputRef.current?.focus();
  }, []);

  // ---------- 标签页状态上报 ----------

  const handleStatusChange = useCallback((tabId: string, s: FileTabStatus) => {
    setTabStatus(prev => {
      const old = prev.get(tabId);
      if (
        old &&
        old.name === s.name &&
        old.editCount === s.editCount &&
        old.searching === s.searching &&
        old.searchPercent === s.searchPercent &&
        old.hitCount === s.hitCount &&
        old.previewing === s.previewing
      ) {
        return prev; // 内容未变化，跳过以避免无谓渲染
      }
      const next = new Map(prev);
      next.set(tabId, s);
      return next;
    });
  }, []);

  // ---------- 全局行为 ----------

  // 主题同步到 :root，供 portal 到 body 的弹层（复制编码菜单 / 各对话框）继承主题变量
  useEffect(() => {
    document.documentElement.dataset.theme = config.theme;
  }, [config.theme]);

  // 拖拽打开文件：Tauri 拦截 WebView 拖放并以原生事件下发（tauri.conf 未关闭 dragDropEnabled）
  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(
      listen('tauri://drag-enter', () => setDragActive(true)),
      listen('tauri://drag-over', () => setDragActive(true)),
      listen('tauri://drag-leave', () => setDragActive(false)),
      listen<{ paths?: string[]; path?: string }>('tauri://drag-drop', e => {
        setDragActive(false);
        const payload = e.payload;
        const paths =
          payload?.paths && payload.paths.length > 0
            ? payload.paths
            : payload?.path
              ? [payload.path]
              : [];
        if (paths.length === 0) return;
        if (paths.length > 1) showToast('暂不支持一次打开多个文件');
        void openNewTab(paths[0]);
      }),
    );
    return () => {
      for (const p of unsubs) p.then(un => un()).catch(() => {});
    };
  }, [openNewTab, showToast]);

  // 全局快捷键：转发到激活标签页的命令通道（标签页内部状态不经过 App）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 任何弹窗打开时（App 关闭确认 / 各标签页 portal 对话框），
      // 全部快捷键交由弹窗自行处理（含 Escape / Enter），与单文件版行为一致
      if (document.querySelector('.modal')) return;
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (ctrl && key === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
      } else if (e.key === 'Escape') {
        getActiveHandle()?.escape();
      } else if (ctrl && key === 'c' && !inInput) {
        // Ctrl+C 复制 Hex，Ctrl+Shift+C 按当前显示编码复制文本（无字节选择时静默）
        e.preventDefault();
        getActiveHandle()?.copySelection(e.shiftKey ? 'text' : 'hex');
      } else if (ctrl && e.shiftKey && key === 'v' && !inInput) {
        // Ctrl+Shift+V 粘贴 Hex（Ctrl+V 保持系统默认文本粘贴不拦截）
        e.preventDefault();
        getActiveHandle()?.paste('hex');
      } else if (ctrl && key === 'b' && !inInput) {
        // Ctrl+B 切换光标处书签；Ctrl+Shift+B 把选择转成标记（预览中禁用，方法内处理）
        e.preventDefault();
        const h = getActiveHandle();
        if (!h) return;
        if (e.shiftKey) h.addMarkFromSelection();
        else h.toggleBookmarkAtCursor();
      } else if (e.key === 'F2' && !inInput) {
        // F2 下一个书签/标记，Shift+F2 上一个（按偏移循环）
        e.preventDefault();
        getActiveHandle()?.jumpBookmarkRelative(e.shiftKey ? -1 : 1);
      } else if (ctrl && key === 's' && !inInput) {
        // Ctrl+S 保存（可配置确认），Ctrl+Shift+S 另存为；预览中禁用（方法内提示）
        e.preventDefault();
        const h = getActiveHandle();
        if (!h) return;
        if (e.shiftKey) h.saveAs();
        else h.saveShortcut();
      } else if (ctrl && (key === 'z' || key === 'y') && !inInput) {
        // Ctrl+Z 撤销最近一次，Ctrl+Y / Ctrl+Shift+Z 恢复最近一次；预览中禁用
        e.preventDefault();
        const h = getActiveHandle();
        if (!h) return;
        if (key === 'y' || e.shiftKey) h.redo();
        else h.undo();
      } else if (ctrl && key === 'e' && !inInput) {
        // Ctrl+E 按当前模式开始编辑
        e.preventDefault();
        getActiveHandle()?.startEdit();
      } else if (e.key === 'Enter' && !inInput) {
        // Enter 开始编辑（行内编辑框是 input，inInput 已跳过）
        e.preventDefault();
        getActiveHandle()?.startEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [getActiveHandle]);

  // 清理 Toast 计时器
  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ---------- 派生展示数据 ----------

  const activeTab =
    tabState.tabs.find(t => t.id === tabState.activeId) ?? tabState.tabs[0] ?? null;
  const activeStatus = activeTab ? tabStatus.get(activeTab.id) ?? null : null;

  const tabItems = useMemo<TabBarItem[]>(
    () =>
      tabState.tabs.map(t => {
        const st = tabStatus.get(t.id);
        return {
          id: t.id,
          path: t.path,
          name: st?.name ?? '',
          dirty: (st?.editCount ?? 0) > 0,
        };
      }),
    [tabState.tabs, tabStatus],
  );

  const closeConfirmStatus = closeConfirmTabId ? tabStatus.get(closeConfirmTabId) : null;

  return (
    <div className="app-container" data-theme={config.theme}>
      {dragActive && (
        <div className="drag-overlay" aria-hidden>
          <div className="drag-overlay-inner">松开以打开文件</div>
        </div>
      )}
      <Toolbar
        hasFile={!!activeTab}
        fileName={activeStatus?.name ?? activeTab?.path.split(/[\\/]/).pop() ?? null}
        onOpenFile={handleOpenFile}
        unsaved={(activeStatus?.editCount ?? 0) > 0}
        onCloseFile={() => activeTab && requestCloseTab(activeTab.id)}
        recentFiles={recentFiles}
        onOpenRecent={p => void openNewTab(p)}
        onClearRecent={clearRecent}
        searchMode={searchMode}
        setSearchMode={setSearchMode}
        searchText={searchText}
        setSearchText={setSearchText}
        caseSensitive={caseSensitive}
        setCaseSensitive={setCaseSensitive}
        onSearch={() =>
          getActiveHandle()?.runSearch(searchMode, searchText, caseSensitive)
        }
        onCancelSearch={() => getActiveHandle()?.cancelSearch()}
        searching={activeStatus?.searching ?? false}
        searchPercent={activeStatus?.searchPercent ?? 0}
        searchInputRef={searchInputRef}
        replaceText={replaceText}
        setReplaceText={setReplaceText}
        replaceOk={replaceOk}
        replaceHint={replaceHint}
        hitCount={activeStatus?.hitCount ?? 0}
        onReplace={() =>
          getActiveHandle()?.replace({ mode: searchMode, searchText, replaceText })
        }
        onReplaceNext={() =>
          getActiveHandle()?.replaceNext({ mode: searchMode, searchText, replaceText })
        }
        onReplaceAll={() =>
          getActiveHandle()?.replaceAll({ mode: searchMode, searchText, replaceText })
        }
        gotoText={gotoText}
        setGotoText={setGotoText}
        onGoto={() => getActiveHandle()?.goto(gotoText)}
        gotoInputRef={gotoInputRef}
        config={config}
        onBytesPerRowChange={setBytesPerRow}
        onZoom={zoomFont}
        onThemeChange={setTheme}
        onToggleAscii={toggleAscii}
        onEncodingChange={setEncoding}
        onByteGroupingChange={setByteGrouping}
        onRowHighlightChange={setRowHighlight}
        onColHighlightChange={setColHighlight}
      />

      <TabBar
        tabs={tabItems}
        activeId={tabState.activeId}
        onSelect={id => setTabState(s => ({ ...s, activeId: id }))}
        onClose={requestCloseTab}
        onNew={handleOpenFile}
      />

      {tabState.tabs.length === 0 ? (
        <div className="hex-viewer hex-viewer-empty">
          <div className="empty-state">
            <div className="empty-title">Hex Viewer</div>
            <div>请打开一个文件以查看内容（支持 1GB+ 大文件）</div>
          </div>
        </div>
      ) : (
        tabState.tabs.map(t => (
          <FileTab
            key={t.id}
            ref={h => {
              if (h) tabHandles.current.set(t.id, h);
              else tabHandles.current.delete(t.id);
            }}
            tabId={t.id}
            path={t.path}
            active={t.id === tabState.activeId}
            config={config}
            onZoom={zoomFont}
            onEditModeChange={setEditMode}
            onConfirmSaveChange={setConfirmSave}
            onVersionModeChange={setVersionMode}
            aiConfig={ai.config}
            onAiConfigChange={ai.updateConfig}
            onAiResetSystemPrompt={ai.resetSystemPrompt}
            toast={t.id === tabState.activeId ? toast : null}
            showToast={showToast}
            onStatusChange={handleStatusChange}
            onOpenFailed={handleOpenFailed}
            onGotoFill={handleGotoFill}
          />
        ))
      )}

      {/* 关闭标签页：有未保存修改时三选一 */}
      {closeConfirmTabId && closeConfirmStatus && (
        <ConfirmDialog
          title="有未保存的修改"
          message={`该标签页有 ${closeConfirmStatus.editCount} 字节未保存修改，如何处理？`}
          buttons={[
            {
              label: '保存并关闭',
              kind: 'primary',
              onClick: () => {
                const id = closeConfirmTabId;
                setCloseConfirmTabId(null);
                const h = tabHandles.current.get(id);
                if (!h) {
                  doCloseTab(id);
                  return;
                }
                void h.save().then(ok => {
                  if (ok) doCloseTab(id); // 保存失败（只读/预览中）保持标签打开
                });
              },
            },
            {
              label: '放弃并关闭',
              kind: 'danger',
              onClick: () => {
                const id = closeConfirmTabId;
                setCloseConfirmTabId(null);
                tabHandles.current.get(id)?.discard(); // 清理 localStorage 编辑历史残留
                doCloseTab(id);
              },
            },
            {
              label: '取消',
              kind: 'plain',
              onClick: () => setCloseConfirmTabId(null),
            },
          ]}
          onCancel={() => setCloseConfirmTabId(null)}
        />
      )}
    </div>
  );
}

export default App;
