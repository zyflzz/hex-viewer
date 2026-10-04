import type { EditMode, FileMeta } from '../types';
import type { EditOp } from '../hooks/useFileEdits';

/** 操作记录最多渲染条数（防止超长列表拖慢侧栏） */
const MAX_LOG_ITEMS = 200;

interface SidebarEditProps {
  meta: FileMeta | null;
  editMode: EditMode;
  onEditModeChange: (m: EditMode) => void;
  confirmSave: boolean;
  onConfirmSaveChange: (v: boolean) => void;
  editCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 撤销最近一次（无确认） */
  onUndo: () => void;
  /** 恢复最近一次 */
  onRedo: () => void;
  /** 撤销到指定操作（含其后全部）；是否需要二次确认由 App 决定 */
  onUndoTo: (index: number) => void;
  /** 恢复到指定操作（含其前被撤销的中间操作） */
  onRedoTo: (index: number) => void;
  /** 操作记录（时间升序，index 即顺序号） */
  ops: EditOp[];
  /** 当前生效操作数：ops[0..pos) 生效，ops[pos..] 已撤销可恢复 */
  pos: number;
  /** 按当前模式开始编辑（Ctrl+E） */
  onEditSelection: () => void;
  /** 放弃全部未保存修改（App 层弹确认） */
  onDiscardAll: () => void;
  /** 预览历史版本中：禁用编辑/撤销/恢复/放弃 */
  locked?: boolean;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('zh-CN', { hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** "编辑"选项卡：编辑模式 / 保存确认 / 撤销恢复 / 操作记录 */
export function SidebarEdit({
  meta,
  editMode,
  onEditModeChange,
  confirmSave,
  onConfirmSaveChange,
  editCount,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onUndoTo,
  onRedoTo,
  ops,
  pos,
  onEditSelection,
  onDiscardAll,
  locked = false,
}: SidebarEditProps) {
  const hasFile = !!meta && meta.size > 0;
  const readonly = !!meta?.is_readonly;
  // 最新在前展示；i 为升序索引
  const items = ops
    .map((op, i) => ({ op, i }))
    .reverse()
    .slice(0, MAX_LOG_ITEMS);

  return (
    <section className="side-section">
      <h3>编辑</h3>
      {!hasFile ? (
        <p className="placeholder-text">打开文件后可用</p>
      ) : (
        <>
          {readonly && <p className="side-error">文件为只读，无法编辑（可另存为）</p>}
          <div className="edit-opt">
            <span className="edit-label">编辑模式</span>
            <div className="seg">
              <button
                className={editMode === 'dialog' ? 'on' : ''}
                onClick={() => onEditModeChange('dialog')}
                title="Ctrl+E 弹出对话框编辑光标/选中区间"
              >
                对话框
              </button>
              <button
                className={editMode === 'direct' ? 'on' : ''}
                onClick={() => onEditModeChange('direct')}
                title="Ctrl+E 或双击 HEX 列字节，原地直接修改"
              >
                直接
              </button>
            </div>
          </div>
          <div className="edit-opt">
            <span className="edit-label">保存前确认</span>
            <button
              className={`toggle${confirmSave ? ' on' : ''}`}
              role="switch"
              aria-checked={confirmSave}
              title="开启后 Ctrl+S 弹出确认对话框"
              onClick={() => onConfirmSaveChange(!confirmSave)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="edit-opt">
            <span className="edit-label">未保存修改</span>
            <span className={`edit-count${editCount > 0 ? ' has' : ''}`}>
              {editCount > 0 ? `${editCount} 字节` : '无修改'}
            </span>
          </div>
          <div className="edit-btns">
            <button
              className="btn mini"
              disabled={readonly || locked}
              onClick={onEditSelection}
              title="按当前模式编辑光标/选中区间（Enter / Ctrl+E）"
            >
              开始编辑
            </button>
            <button
              className="btn mini"
              disabled={!canUndo || locked}
              onClick={onUndo}
              title="撤销最近一次（Ctrl+Z）"
            >
              撤销
            </button>
            <button
              className="btn mini"
              disabled={!canRedo || locked}
              onClick={onRedo}
              title="恢复最近一次（Ctrl+Shift+Z / Ctrl+Y）"
            >
              恢复
            </button>
            <button
              className="btn mini danger"
              disabled={editCount === 0 || locked}
              onClick={onDiscardAll}
              title="放弃全部未保存修改（不可恢复）"
            >
              放弃全部
            </button>
          </div>

          <p className="edit-tip">
            Enter / Ctrl+E 按当前模式开始编辑 · 直接模式可双击 HEX 字节
            <br />
            Ctrl+Z 撤销 · Ctrl+Shift+Z 恢复 · Ctrl+S 保存 · Ctrl+Shift+S 另存为
            <br />
            撤销早期操作会一并撤销其后的操作（需确认）；撤销后继续编辑将放弃被撤销的分支
          </p>

          <div className="edit-log-head">
            <span>操作记录</span>
            {ops.length > 0 && (
              <span className="edit-log-count">
                {pos}/{ops.length} 生效
              </span>
            )}
          </div>
          {ops.length === 0 ? (
            <p className="edit-log-empty">暂无操作记录</p>
          ) : (
            <div className="edit-log">
              {items.map(({ op, i }) => {
                const undone = i >= pos;
                return (
                  <div key={op.id} className={`edit-log-item${undone ? ' undone' : ''}`}>
                    <span
                      className={`op-dot${undone ? ' off' : ''}`}
                      title={undone ? '已撤销（可恢复）' : '已生效'}
                    />
                    <div className="op-main">
                      <span className="op-label" title={op.label}>
                        {op.label}
                      </span>
                      <span className="op-time">
                        {fmtTime(op.time)}
                        {i === pos - 1 ? ' · 当前' : undone ? ' · 已撤销' : ''}
                      </span>
                    </div>
                    {undone ? (
                      <button
                        className="op-act"
                        onClick={() => onRedoTo(i)}
                        title="恢复到此操作（含其前被撤销的操作）"
                      >
                        恢复
                      </button>
                    ) : (
                      <button
                        className="op-act"
                        onClick={() => onUndoTo(i)}
                        title={
                          i === pos - 1
                            ? '撤销此操作'
                            : '撤销此操作及其后的全部操作（需确认）'
                        }
                      >
                        撤销
                      </button>
                    )}
                  </div>
                );
              })}
              {ops.length > MAX_LOG_ITEMS && (
                <div className="bm-more">…共 {ops.length} 条，仅显示最近 {MAX_LOG_ITEMS} 条</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
