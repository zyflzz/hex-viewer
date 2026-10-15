import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** 无选中复制等破坏性提示 */
  danger?: boolean;
}

export interface ContextMenuEntry {
  key: string;
  item?: ContextMenuItem;
  /** 分组分隔线 */
  sep?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

/**
 * 通用右键菜单：portal 到 body、fixed 定位、视口边界自动翻转。
 * 菜单项的启用/禁用由调用方决定；点击外部 / Escape / 选中项后关闭。
 */
export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 挂载后测量尺寸：右/下边缘越界时向左/上翻转
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
    setPos({ left, top });
  }, [x, y, entries]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onCtx = (e: MouseEvent) => {
      // 菜单已打开时在别处再右键：关闭（新菜单由新的 contextmenu 处理器打开）
      if (menuRef.current?.contains(e.target as Node)) e.preventDefault();
      else onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={menuRef} className="ctx-menu" style={pos} onContextMenu={e => e.preventDefault()}>
      {entries.map(entry =>
        entry.sep ? (
          <div key={entry.key} className="ctx-sep" />
        ) : (
          <button
            key={entry.key}
            className={`ctx-item${entry.item!.danger ? ' danger' : ''}`}
            disabled={entry.item!.disabled}
            onClick={() => {
              onClose();
              entry.item!.onSelect?.();
            }}
          >
            {entry.item!.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
