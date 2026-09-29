import React, { useEffect, useRef, useState } from 'react';
import type { DisplayConfig } from '../types';
import type { SearchMode } from '../hooks/useFileSearch';

interface ToolbarProps {
  hasFile: boolean;
  fileName: string | null;
  onOpenFile: () => void;
  // 搜索
  searchMode: SearchMode;
  setSearchMode: (m: SearchMode) => void;
  searchText: string;
  setSearchText: (t: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  onSearch: () => void;
  onCancelSearch: () => void;
  searching: boolean;
  searchPercent: number; // 0..100
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  // 跳转
  gotoText: string;
  setGotoText: (t: string) => void;
  onGoto: () => void;
  gotoInputRef: React.RefObject<HTMLInputElement | null>;
  // 显示配置
  config: DisplayConfig;
  onBytesPerRowChange: (v: DisplayConfig['bytesPerRow']) => void;
  onZoom: (delta: number) => void;
  onThemeChange: (v: DisplayConfig['theme']) => void;
  onToggleAscii: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    hasFile,
    fileName,
    onOpenFile,
    searchMode,
    setSearchMode,
    searchText,
    setSearchText,
    caseSensitive,
    setCaseSensitive,
    onSearch,
    onCancelSearch,
    searching,
    searchPercent,
    searchInputRef,
    gotoText,
    setGotoText,
    onGoto,
    gotoInputRef,
    config,
    onBytesPerRowChange,
    onZoom,
    onThemeChange,
    onToggleAscii,
  } = props;

  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // 点击面板外关闭设置
  useEffect(() => {
    if (!showSettings) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showSettings]);

  return (
    <header className="toolbar">
      <button className="btn primary" onClick={onOpenFile}>
        打开文件
      </button>
      {fileName && (
        <span className="toolbar-file" title={fileName}>
          {fileName}
        </span>
      )}

      <div className="toolbar-sep" />

      <div className="search-group">
        <div className="seg">
          <button
            className={searchMode === 'text' ? 'on' : ''}
            onClick={() => setSearchMode('text')}
            title="按文本搜索（UTF-8 字节序列）"
          >
            文本
          </button>
          <button
            className={searchMode === 'hex' ? 'on' : ''}
            onClick={() => setSearchMode('hex')}
            title="按十六进制字节搜索（如 AB CD 或 0xABCD）"
          >
            Hex
          </button>
        </div>
        <input
          ref={searchInputRef}
          className="input search-input"
          placeholder={searchMode === 'hex' ? 'Hex 字节，如 89504E47' : '搜索文本…'}
          value={searchText}
          disabled={!hasFile}
          onChange={e => setSearchText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSearch();
          }}
        />
        <button
          className={`btn icon${caseSensitive ? ' on' : ''}`}
          title="区分大小写"
          onClick={() => setCaseSensitive(!caseSensitive)}
        >
          Aa
        </button>
        {searching ? (
          <button className="btn" onClick={onCancelSearch} title="取消搜索">
            取消 {searchPercent > 0 ? `${searchPercent}%` : ''}
          </button>
        ) : (
          <button className="btn" disabled={!hasFile || !searchText.trim()} onClick={onSearch}>
            搜索
          </button>
        )}
      </div>

      <div className="toolbar-sep" />

      <div className="goto-group">
        <input
          ref={gotoInputRef}
          className="input goto-input"
          placeholder="跳转偏移 (Hex/Dec)"
          disabled={!hasFile}
          value={gotoText}
          onChange={e => setGotoText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onGoto();
          }}
        />
        <button className="btn" disabled={!hasFile || !gotoText.trim()} onClick={onGoto}>
          跳转
        </button>
      </div>

      <div className="toolbar-flex" />

      <div className="settings-anchor" ref={settingsRef}>
        <button
          className={`btn icon${showSettings ? ' on' : ''}`}
          title="显示配置"
          onClick={() => setShowSettings(s => !s)}
        >
          显示
        </button>
        {showSettings && (
          <div className="settings-pop">
            <div className="settings-row">
              <label>每行字节</label>
              <div className="seg">
                {([8, 16, 32] as const).map(n => (
                  <button
                    key={n}
                    className={config.bytesPerRow === n ? 'on' : ''}
                    onClick={() => onBytesPerRowChange(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <label>字体大小</label>
              <div className="stepper">
                <button className="btn icon" onClick={() => onZoom(-1)}>
                  −
                </button>
                <span className="stepper-value">{config.fontSize}px</span>
                <button className="btn icon" onClick={() => onZoom(1)}>
                  +
                </button>
              </div>
            </div>
            <div className="settings-row">
              <label>颜色主题</label>
              <div className="seg">
                {(
                  [
                    ['dark', '深色'],
                    ['light', '浅色'],
                    ['contrast', '高对比'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    className={config.theme === v ? 'on' : ''}
                    onClick={() => onThemeChange(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <label>ASCII 列</label>
              <div className="seg">
                <button className={config.showAscii ? 'on' : ''} onClick={onToggleAscii}>
                  {config.showAscii ? '显示' : '隐藏'}
                </button>
              </div>
            </div>
            <div className="settings-hint">Ctrl+滚轮 缩放 · Ctrl+F 搜索 · Ctrl+G 跳转 · 拖选字节后 Ctrl+C 复制</div>
          </div>
        )}
      </div>
    </header>
  );
}
