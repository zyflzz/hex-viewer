/** 文件标签页栏（工具栏下方）：文件名 + 未保存圆点 + 关闭按钮，"+" 新开文件 */

export interface TabBarItem {
  id: string;
  path: string;
  /** 展示名（文件名，由状态上报提供，打开前回退为路径尾部） */
  name: string;
  /** 有未保存修改 */
  dirty: boolean;
  /** 对比标签页（只读，双文件并排）：显示区分图标与配色 */
  kind?: 'diff';
}

interface TabBarProps {
  tabs: TabBarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 请求关闭（有未保存修改时 App 层弹三选一确认） */
  onClose: (id: string) => void;
  /** "+" 按钮：打开系统文件选择框 */
  onNew: () => void;
}

function pathTail(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onNew }: TabBarProps) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(t => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`tab-item${t.id === activeId ? ' on' : ''}${t.kind === 'diff' ? ' tab-item-diff' : ''}`}
          title={t.path}
          onClick={() => onSelect(t.id)}
          // 中键关闭标签页
          onMouseDown={e => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(t.id);
            }
          }}
        >
          {t.kind === 'diff' && <span className="tab-diff-icon" aria-hidden>⇄</span>}
          {t.dirty && <span className="tab-dirty" title="有未保存的修改" />}
          <span className="tab-name">{t.name || pathTail(t.path)}</span>
          <button
            className="tab-close"
            title="关闭标签页"
            onClick={e => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" title="打开文件（新标签页）" onClick={onNew}>
        +
      </button>
    </div>
  );
}
