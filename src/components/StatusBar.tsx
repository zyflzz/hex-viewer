import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileMeta, Selection, TextEncoding } from '../types';
import { formatBytes, hexOffset, offsetDigits } from '../utils/format';
import { ENCODING_OPTIONS, encodingLabel } from '../utils/decode';

interface StatusBarProps {
  meta: FileMeta | null;
  hoverOffset: number | null;
  cursorOffset: number | null;
  selection: Selection | null;
  rowBytes: number;
  encoding: TextEncoding;
  loading: boolean;
  toast: string | null;
  onCopyHex: () => void;
  /** 按指定编码把选中字节解码为文本并复制 */
  onCopyText: (encoding: TextEncoding) => void;
}

export function StatusBar({
  meta,
  hoverOffset,
  cursorOffset,
  selection,
  rowBytes,
  encoding,
  loading,
  toast,
  onCopyHex,
  onCopyText,
}: StatusBarProps) {
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const dropBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const showCopyMenu = menuPos !== null;

  const closeMenu = useCallback(() => setMenuPos(null), []);

  const toggleMenu = useCallback(() => {
    const rect = dropBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos(prev => {
      if (prev) return null; // 已打开则关闭
      const MENU_WIDTH = 150;
      return {
        top: rect.top - 6, // 菜单底缘在按钮上方 6px
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      };
    });
  }, []);

  // 点击菜单/按钮外或窗口尺寸变化时关闭
  useEffect(() => {
    if (!showCopyMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || dropBtnRef.current?.contains(t)) return;
      closeMenu();
    };
    const onResize = () => closeMenu();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [showCopyMenu, closeMenu]);

  const digits = meta ? offsetDigits(meta.size) : 8;
  const selCount = selection ? selection.end - selection.start + 1 : 0;

  return (
    <footer className="statusbar">
      <span className="status-item">
        偏移 <span className="mono">{hoverOffset !== null ? hexOffset(hoverOffset, digits) : '—'}</span>
      </span>
      <span className="status-item">
        光标 <span className="mono">{cursorOffset !== null ? hexOffset(cursorOffset, digits) : '—'}</span>
      </span>
      {selection && (
        <span className="status-item">
          选择{' '}
          <span className="mono">
            {hexOffset(selection.start, digits)}–{hexOffset(selection.end, digits)}
          </span>{' '}
          ({selCount} B)
          <button className="btn mini" onClick={onCopyHex} title="复制选中字节的十六进制">
            复制 Hex
          </button>
          <span className="copy-anchor">
            <button
              className="btn mini"
              title={`按当前显示编码（${encodingLabel(encoding)}）解码选中字节并复制`}
              onClick={() => onCopyText(encoding)}
            >
              复制文本
            </button>
            <button
              ref={dropBtnRef}
              className={`btn mini icon${showCopyMenu ? ' on' : ''}`}
              title="选择编码复制"
              onClick={toggleMenu}
            >
              ▾
            </button>
          </span>
        </span>
      )}
      {showCopyMenu &&
        createPortal(
          <div ref={menuRef} className="copy-menu" style={{ top: menuPos.top, left: menuPos.left }}>
            <div className="copy-menu-title">按编码复制文本</div>
            {ENCODING_OPTIONS.map(o => (
              <button
                key={o.value}
                className={o.value === encoding ? 'on' : ''}
                onClick={() => {
                  closeMenu();
                  onCopyText(o.value);
                }}
              >
                {o.label}
                {o.value === encoding ? ' ·当前' : ''}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {meta && (
        <span className="status-item">
          编码 <span className="mono">{encodingLabel(encoding)}</span>
        </span>
      )}
      {meta && (
        <span className="status-item">
          每行 {rowBytes} B · 共 {formatBytes(meta.size)}
        </span>
      )}
      {loading && (
        <span className="status-item status-loading">
          <span className="spin" />
          加载分片…
        </span>
      )}
      <span className="status-flex" />
      {toast && <span className="status-toast">{toast}</span>}
    </footer>
  );
}
