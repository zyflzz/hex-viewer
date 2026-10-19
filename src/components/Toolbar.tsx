import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DisplayConfig, TextEncoding } from '../types';
import type { SearchMode } from '../hooks/useFileSearch';
import type { RecentFile } from '../hooks/useRecentFiles';
import { ENCODING_OPTIONS } from '../utils/decode';

interface ToolbarProps {
  hasFile: boolean;
  fileName: string | null;
  onOpenFile: () => void;
  /** 是否有未保存修改（文件名旁显示 •） */
  unsaved: boolean;
  /** 关闭当前文件（有未保存修改时 App 层弹确认） */
  onCloseFile: () => void;
  /** 发起文件对比（App 弹左右文件选择） */
  onCompare: () => void;
  /** 已打开的文件标签 ≥ 2 才可对比 */
  canCompare: boolean;
  // 最近文件
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
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
  // 查找替换
  replaceText: string;
  setReplaceText: (t: string) => void;
  /** 替换内容校验结果（长度与搜索内容一致且格式合法） */
  replaceOk: boolean;
  /** 校验失败原因（按钮禁用时展示） */
  replaceHint: string | null;
  /** 当前命中数（无结果时替换按钮禁用） */
  hitCount: number;
  onReplace: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
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
  onEncodingChange: (v: TextEncoding) => void;
  onByteGroupingChange: (v: DisplayConfig['byteGrouping']) => void;
  onRowHighlightChange: (v: boolean) => void;
  onColHighlightChange: (v: boolean) => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    hasFile,
    fileName,
    onOpenFile,
    unsaved,
    onCloseFile,
    onCompare,
    canCompare,
    recentFiles,
    onOpenRecent,
    onClearRecent,
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
    replaceText,
    setReplaceText,
    replaceOk,
    replaceHint,
    hitCount,
    onReplace,
    onReplaceNext,
    onReplaceAll,
    gotoText,
    setGotoText,
    onGoto,
    gotoInputRef,
    config,
    onBytesPerRowChange,
    onZoom,
    onThemeChange,
    onToggleAscii,
    onEncodingChange,
    onByteGroupingChange,
    onRowHighlightChange,
    onColHighlightChange,
  } = props;

  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [showReplace, setShowReplace] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [recentPos, setRecentPos] = useState<{ top: number; left: number } | null>(null);
  const recentBtnRef = useRef<HTMLButtonElement>(null);
  const recentMenuRef = useRef<HTMLDivElement>(null);

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

  // 展开替换面板时聚焦替换输入框
  useEffect(() => {
    if (showReplace) replaceInputRef.current?.focus();
  }, [showReplace]);

  const toggleRecent = () => {
    setRecentPos(prev => {
      if (prev) return null;
      const rect = recentBtnRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return { top: rect.bottom + 6, left: rect.left };
    });
  };

  // 点击外部 / 窗口尺寸变化关闭最近文件列表
  useEffect(() => {
    if (!recentPos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (recentMenuRef.current?.contains(t) || recentBtnRef.current?.contains(t)) return;
      setRecentPos(null);
    };
    const onResize = () => setRecentPos(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [recentPos]);

  return (
    <header className="toolbar">
      <span className="open-anchor">
        <button className="btn primary" onClick={onOpenFile}>
          打开文件
        </button>
        <button
          ref={recentBtnRef}
          className={`btn icon open-recent${recentPos ? ' on' : ''}`}
          title="最近打开的文件"
          disabled={recentFiles.length === 0}
          onClick={toggleRecent}
        >
          ▾
        </button>
      </span>
      {fileName && (
        <span className="toolbar-file" title={fileName}>
          {unsaved && (
            <span className="unsaved-dot" title="有未保存的修改">
              ●
            </span>
          )}
          {fileName}
        </span>
      )}
      {hasFile && (
        <button
          className="btn icon file-close"
          onClick={onCloseFile}
          title="关闭当前文件"
        >
          ✕
        </button>
      )}
      <button
        className="btn mini"
        onClick={onCompare}
        disabled={!canCompare}
        title="对比两个已打开的文件（只读，同步滚动 + 差异高亮）"
      >
        ⇄ 对比
      </button>

      <div className="toolbar-sep" />

      <div className="search-anchor">
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
          <button
            className={`btn icon${showReplace ? ' on' : ''}`}
            title={showReplace ? '收起替换面板' : '展开替换面板'}
            onClick={() => setShowReplace(s => !s)}
          >
            ▾
          </button>
        </div>
        {showReplace && (
          <div className="replace-pop">
            <input
              ref={replaceInputRef}
              className="input replace-input"
              placeholder={
                searchMode === 'hex' ? '替换 Hex，如 48 65 6C 70（等长）' : '替换文本（与搜索内容等长）…'
              }
              value={replaceText}
              disabled={!hasFile}
              spellCheck={false}
              onChange={e => setReplaceText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onReplaceNext();
              }}
            />
            <button
              className="btn"
              disabled={!replaceOk || hitCount === 0 || searching}
              title={replaceHint ?? '替换当前活跃命中'}
              onClick={onReplace}
            >
              替换
            </button>
            <button
              className="btn"
              disabled={!replaceOk || hitCount === 0 || searching}
              title={replaceHint ?? '替换当前命中并跳到下一个'}
              onClick={onReplaceNext}
            >
              替换下一个
            </button>
            <button
              className="btn primary"
              disabled={!replaceOk || hitCount === 0 || searching}
              title={replaceHint ?? `替换全部 ${hitCount} 处命中`}
              onClick={onReplaceAll}
            >
              全部替换{hitCount > 0 ? `（${hitCount > 999 ? '999+' : hitCount}）` : ''}
            </button>
            {replaceHint && <div className="replace-hint err">{replaceHint}</div>}
          </div>
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
              <label>文本编码</label>
              <select
                className="select"
                title="右侧栏文本按所选编码解释"
                value={config.encoding}
                onChange={e => onEncodingChange(e.target.value as TextEncoding)}
              >
                {ENCODING_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <label>ASCII 列</label>
              <div className="seg">
                <button className={config.showAscii ? 'on' : ''} onClick={onToggleAscii}>
                  {config.showAscii ? '显示' : '隐藏'}
                </button>
              </div>
            </div>
            <div className="settings-row">
              <label>字节分组</label>
              <div className="seg">
                {([1, 2, 4, 8] as const).map(n => (
                  <button
                    key={n}
                    className={config.byteGrouping === n ? 'on' : ''}
                    title={n === 1 ? '不分组' : `每 ${n} 字节一组`}
                    onClick={() => onByteGroupingChange(n)}
                  >
                    {n === 1 ? '无' : n}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <label>行 / 列高亮</label>
              <div className="seg">
                <button
                  className={config.rowHighlight ? 'on' : ''}
                  title="光标所在行浅色高亮"
                  onClick={() => onRowHighlightChange(!config.rowHighlight)}
                >
                  行
                </button>
                <button
                  className={config.colHighlight ? 'on' : ''}
                  title="光标所在列浅色高亮（纵向对齐参考）"
                  onClick={() => onColHighlightChange(!config.colHighlight)}
                >
                  列
                </button>
              </div>
            </div>
            <div className="settings-hint">Ctrl+滚轮 缩放 · Ctrl+F 搜索 · Ctrl+G 跳转 · 拖选字节后 Ctrl+C 复制 · Ctrl+Shift+V 粘贴 Hex · Alt+←/→ 跳转历史</div>
          </div>
        )}
      </div>

      {/* 最近文件列表：portal 到 body + fixed 定位，避免被工具栏裁剪 */}
      {recentPos &&
        createPortal(
          <div ref={recentMenuRef} className="recent-pop" style={recentPos}>
            <div className="recent-title">最近打开</div>
            {recentFiles.map(f => {
              const name = f.path.split(/[\\/]/).pop() ?? f.path;
              return (
                <button
                  key={f.path}
                  className="recent-item"
                  title={f.path}
                  onClick={() => {
                    setRecentPos(null);
                    onOpenRecent(f.path);
                  }}
                >
                  <span className="recent-name">{name}</span>
                  <span className="recent-path">{f.path}</span>
                </button>
              );
            })}
            <button className="recent-clear" onClick={onClearRecent}>
              清空最近记录
            </button>
          </div>,
          document.body,
        )}
    </header>
  );
}
