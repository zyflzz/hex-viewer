import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { HexViewer, type HexViewerHandle } from './components/HexViewer';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { useDisplayConfig } from './hooks/useDisplayConfig';
import { useFileWindow } from './hooks/useFileWindow';
import { useFileSearch, type SearchMode } from './hooks/useFileSearch';
import { useFileStats } from './hooks/useFileStats';
import { usePerfMonitor } from './hooks/usePerfMonitor';
import type { Selection } from './types';
import { byteToAscii, hexByte, parseOffsetInput } from './utils/format';
import './App.css';

const MAX_COPY_BYTES = 4 * 1024 * 1024;

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function App() {
  const {
    config,
    setBytesPerRow,
    zoomFont,
    setTheme,
    toggleAscii,
  } = useDisplayConfig();
  const {
    fileMeta,
    cacheVersion,
    cacheBytes,
    loading,
    openFile,
    ensureRange,
    getBytes,
    readRange,
  } = useFileWindow();
  const search = useFileSearch(fileMeta);
  const stats = useFileStats(fileMeta);
  const perf = usePerfMonitor(true);

  const hexViewerRef = useRef<HexViewerHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [hoverOffset, setHoverOffset] = useState<number | null>(null);
  const [flashOffset, setFlashOffset] = useState<number | null>(null);
  const [activeHitOffset, setActiveHitOffset] = useState<number | null>(null);
  const [visibleRange, setVisibleRange] = useState<{ first: number; last: number }>({
    first: 0,
    last: 0,
  });

  // 工具栏输入状态
  const [searchMode, setSearchMode] = useState<SearchMode>('text');
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [gotoText, setGotoText] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const totalRows = fileMeta ? Math.ceil(fileMeta.size / config.bytesPerRow) : 0;
  const visibleRows = Math.max(0, visibleRange.last - visibleRange.first + 1);

  const handleOpenFile = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      });
      if (!selected) return;
      setSelection(null);
      setHoverOffset(null);
      setActiveHitOffset(null);
      setFlashOffset(null);
      await openFile(selected as string);
    } catch (err) {
      showToast(`打开文件失败: ${err}`);
      console.error(err);
    }
  }, [openFile, showToast]);

  /** 跳转到指定字节偏移（居中 + 闪烁高亮） */
  const jumpToOffset = useCallback(
    (offset: number) => {
      const size = fileMeta?.size ?? 0;
      if (size === 0) return;
      const target = Math.max(0, Math.min(offset, size - 1));
      setFlashOffset(target);
      hexViewerRef.current?.scrollToOffset(target);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashOffset(null), 1200);
    },
    [fileMeta],
  );

  const handleGoto = useCallback(() => {
    if (!fileMeta) return;
    const parsed = parseOffsetInput(gotoText);
    if (parsed === null) {
      showToast('无效的偏移（支持 0x 前缀 Hex 或十进制）');
      return;
    }
    if (parsed >= fileMeta.size) {
      showToast('偏移超出文件末尾');
      return;
    }
    jumpToOffset(parsed);
  }, [fileMeta, gotoText, jumpToOffset, showToast]);

  const handleSearch = useCallback(() => {
    search.runSearch(searchMode, searchText, caseSensitive);
  }, [search, searchMode, searchText, caseSensitive]);

  /** 复制选中字节（Hex / ASCII） */
  const copySelection = useCallback(
    async (mode: 'hex' | 'ascii') => {
      if (!selection) return;
      const len = selection.end - selection.start + 1;
      if (len > MAX_COPY_BYTES) {
        showToast(`选择过大（${len} 字节），上限 4MB`);
        return;
      }
      try {
        const data = await readRange(selection.start, len);
        let text: string;
        if (mode === 'hex') {
          const parts = new Array<string>(data.length);
          for (let i = 0; i < data.length; i++) parts[i] = hexByte(data[i]);
          text = parts.join(' ');
        } else {
          text = Array.from(data, byteToAscii).join('');
        }
        await writeClipboard(text);
        showToast(`已复制 ${len} 字节（${mode === 'hex' ? 'Hex' : 'ASCII'}）`);
      } catch (err) {
        console.error(err);
        showToast('复制失败');
      }
    },
    [selection, readRange, showToast],
  );

  const handleVisibleRangeChange = useCallback(
    (startByte: number, endByte: number) => {
      ensureRange(startByte, endByte);
      const rb = config.bytesPerRow;
      setVisibleRange({
        first: Math.floor(startByte / rb),
        last: Math.floor(endByte / rb),
      });
    },
    [ensureRange, config.bytesPerRow],
  );

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        setSelection(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (ctrl && key === 'c' && !inInput && selection) {
        e.preventDefault();
        copySelection(e.shiftKey ? 'ascii' : 'hex');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, copySelection]);

  // 清理计时器
  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const searchPercent =
    search.progress && search.progress.total > 0
      ? Math.floor((search.progress.searched / search.progress.total) * 100)
      : 0;

  return (
    <div className="app-container" data-theme={config.theme}>
      <Toolbar
        hasFile={!!fileMeta}
        fileName={fileMeta?.name ?? null}
        onOpenFile={handleOpenFile}
        searchMode={searchMode}
        setSearchMode={setSearchMode}
        searchText={searchText}
        setSearchText={setSearchText}
        caseSensitive={caseSensitive}
        setCaseSensitive={setCaseSensitive}
        onSearch={handleSearch}
        onCancelSearch={search.cancelSearch}
        searching={search.running}
        searchPercent={searchPercent}
        searchInputRef={searchInputRef}
        gotoText={gotoText}
        setGotoText={setGotoText}
        onGoto={handleGoto}
        gotoInputRef={gotoInputRef}
        config={config}
        onBytesPerRowChange={setBytesPerRow}
        onZoom={zoomFont}
        onThemeChange={setTheme}
        onToggleAscii={toggleAscii}
      />

      <div className="main-content">
        <main className="hex-display">
          {fileMeta ? (
            <HexViewer
              key={`${fileMeta.path}::${fileMeta.size}`}
              ref={hexViewerRef}
              meta={fileMeta}
              config={config}
              cacheVersion={cacheVersion}
              getBytes={getBytes}
              onVisibleRangeChange={handleVisibleRangeChange}
              selection={selection}
              onSelectionChange={setSelection}
              hoverOffset={hoverOffset}
              onHoverOffsetChange={setHoverOffset}
              flashOffset={flashOffset}
              onZoom={zoomFont}
            />
          ) : (
            <div className="hex-viewer hex-viewer-empty">
              <div className="empty-state">
                <div className="empty-title">Hex Viewer</div>
                <div>请打开一个文件以查看内容（支持 1GB+ 大文件）</div>
              </div>
            </div>
          )}
        </main>

        <Sidebar
          meta={fileMeta}
          stats={stats}
          search={search}
          perf={perf}
          cacheBytes={cacheBytes}
          visibleRows={visibleRows}
          totalRows={totalRows}
          activeHitOffset={activeHitOffset}
          onJumpToOffset={offset => {
            setActiveHitOffset(offset);
            jumpToOffset(offset);
          }}
        />
      </div>

      <StatusBar
        meta={fileMeta}
        hoverOffset={hoverOffset}
        selection={selection}
        rowBytes={config.bytesPerRow}
        loading={loading}
        toast={toast}
        onCopyHex={() => copySelection('hex')}
        onCopyAscii={() => copySelection('ascii')}
      />
    </div>
  );
}

export default App;
