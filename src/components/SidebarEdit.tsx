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
  /** 保存前自动备份原文件（v1.1.5） */
  backupEnabled: boolean;
  onBackupEnabledChange: (v: boolean) => void;
  /** 备份保留份数 */
  backupCount: number;
  onBackupCountChange: (n: 1 | 2 | 3 | 5 | 10) => void;
  /** 保存后 SHA-256 校验 */
  verifySave: boolean;
  onVerifySaveChange: (v: boolean) => void;
  /** 打开"从备份恢复"对话框 */
  onRestoreBackup: () => void;
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
  /** 填充选中区间（无选中时 App 层提示） */
  onFill: () => void;
  /** 从光标/选择起点粘贴 Hex（Ctrl+Shift+V） */
  onPasteHex: () => void;
  /** 按当前显示编码粘贴文本 */
  onPasteText: () => void;
  /** 在光标/选择起点前插入字节（Insert 键，弹对话框） */
  onInsert: () => void;
  /** 删除选中区间 / 光标处单字节（Delete 键） */
  onDeleteRange: () => void;
  /** 剪切选中区间（Ctrl+X：复制 + 删除） */
  onCut: () => void;
  /** 把剪贴板内容插入到光标处（Ctrl+Shift+Insert） */
  onInsertFromClipboard: () => void;
  /** 当前是否有选中区间（剪切禁用态） */
  hasSelection: boolean;
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

/** "编辑"选项卡：编辑模式 / 保存确认 / 数据安全（备份+校验） / 撤销恢复 / 操作记录 */
export function SidebarEdit({
  meta,
  editMode,
  onEditModeChange,
  confirmSave,
  onConfirmSaveChange,
  backupEnabled,
  onBackupEnabledChange,
  backupCount,
  onBackupCountChange,
  verifySave,
  onVerifySaveChange,
  onRestoreBackup,
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
  onFill,
  onPasteHex,
  onPasteText,
  onInsert,
  onDeleteRange,
  onCut,
  onInsertFromClipboard,
  hasSelection,
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
            <span className="edit-label">自动备份</span>
            <button
              className={`toggle${backupEnabled ? ' on' : ''}`}
              role="switch"
              aria-checked={backupEnabled}
              title="就地保存前自动把磁盘原文件滚动备份一份（防覆盖丢失）"
              onClick={() => onBackupEnabledChange(!backupEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {backupEnabled && (
            <div className="edit-opt">
              <span className="edit-label">保留份数</span>
              <select
                className="select"
                value={backupCount}
                onChange={e => onBackupCountChange(Number(e.target.value) as 1 | 2 | 3 | 5 | 10)}
                title="同名 .bak / .bak.1 / .bak.2 … 滚动保留的份数"
              >
                {[1, 2, 3, 5, 10].map(n => (
                  <option key={n} value={n}>
                    {n} 份
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="edit-opt">
            <span className="edit-label">保存后校验</span>
            <button
              className={`toggle${verifySave ? ' on' : ''}`}
              role="switch"
              aria-checked={verifySave}
              title="保存后对磁盘文件做 SHA-256 比对（大文件 >500MB 自动跳过第二层校验）"
              onClick={() => onVerifySaveChange(!verifySave)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {meta && (
            <div className="edit-opt">
              <span className="edit-label">备份恢复</span>
              <button className="btn mini" onClick={onRestoreBackup} title="从 .bak 备份覆盖当前文件">
                从备份恢复…
              </button>
            </div>
          )}
          {meta && meta.size > 500 * 1024 * 1024 && (
            <p className="edit-tip">当前文件较大，自动备份与保存后校验会占用较多磁盘读取时间，可在上方按需关闭</p>
          )}
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
              disabled={readonly || locked}
              onClick={onFill}
              title="把选中区间全部填充为指定字节值"
            >
              填充区间
            </button>
            <button
              className="btn mini"
              disabled={readonly || locked}
              onClick={onPasteHex}
              title="把剪贴板 Hex 写入光标/选择起点（Ctrl+Shift+V）"
            >
              粘贴 Hex
            </button>
            <button
              className="btn mini"
              disabled={readonly || locked}
              onClick={onPasteText}
              title="按当前显示编码把剪贴板文本写入光标/选择起点"
            >
              粘贴文本
            </button>
            <button
              className="btn mini"
              disabled={readonly || locked}
              onClick={onInsert}
              title="在光标/选择起点前插入字节（Insert 键，支持 Hex / 文本 / 文件）"
            >
              插入字节
            </button>
            <button
              className="btn mini"
              disabled={readonly || locked}
              onClick={onInsertFromClipboard}
              title="把剪贴板内容插入到光标处（Ctrl+Shift+Insert）"
            >
              插入剪贴板
            </button>
            <button
              className="btn mini danger"
              disabled={readonly || locked}
              onClick={onDeleteRange}
              title="删除选中区间 / 光标处单字节（Delete 键）"
            >
              删除
            </button>
            <button
              className="btn mini"
              disabled={readonly || locked || !hasSelection}
              onClick={onCut}
              title="剪切选中区间：复制后删除（Ctrl+X）"
            >
              剪切
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
            Insert 在光标处插入 · Delete 删除选中/单字节 · Ctrl+X 剪切选中
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
