import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandDef } from '../types';

interface CommandPaletteProps {
  /** 全局命令 + 激活文件命令的合并列表（App 在打开时构建） */
  commands: CommandDef[];
  onRun: (id: string) => void;
  onClose: () => void;
}

/**
 * 快捷命令面板（Ctrl+Shift+P）：居中浮层，小写包含匹配（label / category），
 * ↑↓ 选择、Enter 执行、Esc 关闭；点遮罩关闭。
 * 根节点带 .modal 类：期间 App 层全局快捷键自动让位。
 */
export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 小写包含匹配（命令名 / 分类）
  const q = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (!q) return commands;
    return commands.filter(
      c => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
    );
  }, [commands, q]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  // 选中项滚动跟随
  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-item.on')
      ?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (id: string) => {
    onClose();
    onRun(id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(s => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(s => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[sel];
      if (item) run(item.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="modal command-palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input mono"
          value={query}
          placeholder="输入命令名筛选（↑↓ 选择，Enter 执行，Esc 关闭）"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="palette-empty">没有匹配的命令</div>
          ) : (
            items.map((c, i) => (
              <button
                key={c.id}
                className={`palette-item${i === sel ? ' on' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(c.id)}
              >
                <span className="palette-label">{c.label}</span>
                <span className="palette-meta">
                  {c.category}
                  {c.shortcut ? ` · ${c.shortcut}` : ''}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
