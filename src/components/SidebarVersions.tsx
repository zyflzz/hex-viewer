import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VersionMode } from '../types';
import type { CleanupOptions, VersionMeta } from '../hooks/useFileVersions';
import { formatBytes, formatNumber, fmtVersionTime } from '../utils/format';

/** 版本列表最多渲染条数（更早的折叠提示） */
const MAX_LIST_ITEMS = 100;

interface VersionItemProps {
  v: VersionMeta;
  /** 该版本正在预览中 */
  previewing: boolean;
  /** 文件只读：禁恢复，允许预览 */
  readonly: boolean;
  onTogglePreview: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
}

/** 单个版本条目：标签（点击重命名）、时间、改动字节数、预览/恢复/删除 */
function VersionItem({
  v,
  previewing,
  readonly,
  onTogglePreview,
  onRestore,
  onDelete,
  onRename,
}: VersionItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v.label);

  const commit = () => {
    const label = draft.trim();
    if (label && label !== v.label) onRename(v.id, label);
    setEditing(false);
  };

  return (
    <li className={`ver-item${previewing ? ' previewing' : ''}`}>
      <div className="ver-line">
        {editing ? (
          <input
            className="ver-name-input"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') {
                setDraft(v.label);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="ver-label"
            title={`${v.label}（点击重命名）`}
            onClick={() => {
              setDraft(v.label);
              setEditing(true);
            }}
          >
            {v.label}
          </span>
        )}
        <span className="ver-time">{fmtVersionTime(v.time)}</span>
        <button className="ver-del" title="删除此版本" onClick={() => onDelete(v.id)}>
          ×
        </button>
      </div>
      <div className="ver-line ver-sub">
        <span className="ver-bytes">
          {v.byteCount === 0 ? '基线' : `${formatNumber(v.byteCount)} 字节改动`}
        </span>
        <span className="ver-acts">
          <button
            className={`ver-act${previewing ? ' on' : ''}`}
            title={previewing ? '退出预览' : '预览此版本内容（只读）'}
            onClick={() => onTogglePreview(v.id)}
          >
            {previewing ? '预览中' : '预览'}
          </button>
          <button
            className="ver-act"
            disabled={readonly}
            title={readonly ? '文件为只读，无法恢复' : '把此版本内容恢复为未保存修改（可撤销）'}
            onClick={() => onRestore(v.id)}
          >
            恢复
          </button>
        </span>
      </div>
    </li>
  );
}

interface SidebarVersionsProps {
  mode: VersionMode;
  onModeChange: (m: VersionMode) => void;
  versions: VersionMeta[];
  previewId: string | null;
  /** 处于任一版本预览中（禁记录） */
  previewActive: boolean;
  /** 文件只读 */
  readonly: boolean;
  overLimit: boolean;
  globalSize: number;
  /** 手动记录当前状态为一个版本 */
  onRecord: () => void;
  onTogglePreview: (id: string) => void;
  /** 恢复（App 层弹确认） */
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onCleanup: (opts: CleanupOptions) => void;
}

type CleanMode = 'count' | 'days' | 'all';

/** "历史版本"区块：记录模式 / 版本列表 / 清理（嵌入编辑选项卡，位于未保存修改与操作记录之间） */
export function SidebarVersions({
  mode,
  onModeChange,
  versions,
  previewId,
  previewActive,
  readonly,
  overLimit,
  globalSize,
  onRecord,
  onTogglePreview,
  onRestore,
  onDelete,
  onRename,
  onCleanup,
}: SidebarVersionsProps) {
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanMode, setCleanMode] = useState<CleanMode>('count');
  const [keepCount, setKeepCount] = useState(20);
  const [keepDays, setKeepDays] = useState(7);

  // Escape 关闭清理对话框
  useEffect(() => {
    if (!cleanOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCleanOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cleanOpen]);

  // 待删除版本预览（列表最新在前：count 模式跳过最新 N 个，days 模式保留时间线内的）
  const victims =
    cleanMode === 'all'
      ? versions
      : cleanMode === 'count'
        ? versions.slice(Math.max(1, keepCount))
        : versions.filter(v => v.time < Date.now() - Math.max(0, keepDays) * 86_400_000);
  const freeBytes = victims.reduce((s, v) => s + v.sizeBytes, 0);

  const runCleanup = () => {
    setCleanOpen(false);
    onCleanup(
      cleanMode === 'all'
        ? { all: true }
        : cleanMode === 'count'
          ? { keepCount: Math.max(1, keepCount) }
          : { keepDays: Math.max(0, keepDays) },
    );
  };

  return (
    <>
      <div className="edit-log-head">
        <span>历史版本</span>
        {versions.length > 0 && (
          <span className="edit-log-count">{formatNumber(versions.length)} 个</span>
        )}
      </div>
      <div className="edit-opt">
        <span className="edit-label">记录模式</span>
        <div className="seg">
          <button
            className={mode === 'auto' ? 'on' : ''}
            onClick={() => onModeChange('auto')}
            title="每次成功保存（含另存为）后自动记录一个版本"
          >
            保存时自动
          </button>
          <button
            className={mode === 'manual' ? 'on' : ''}
            onClick={() => onModeChange('manual')}
            title="仅手动点击「记录版本」时记录"
          >
            手动
          </button>
        </div>
      </div>
      <div className="edit-btns">
        <button
          className="btn mini"
          disabled={readonly || previewActive}
          title={
            readonly
              ? '文件为只读，无法记录版本'
              : previewActive
                ? '预览历史版本中，请先返回当前内容'
                : '把当前内容记录为一个版本'
          }
          onClick={onRecord}
        >
          记录版本
        </button>
        <button
          className="btn mini danger"
          disabled={versions.length === 0}
          title="批量清理旧版本"
          onClick={() => setCleanOpen(true)}
        >
          清理…
        </button>
      </div>
      {overLimit && (
        <p className="side-error">版本存储已达 {formatBytes(globalSize)}（超过 2 GB），建议清理旧版本</p>
      )}
      {versions.length === 0 ? (
        <p className="edit-log-empty">
          {mode === 'auto' ? '保存文件后将自动记录版本' : '点击「记录版本」保存当前内容快照'}
        </p>
      ) : (
        <ul className="ver-list">
          {versions.slice(0, MAX_LIST_ITEMS).map(v => (
            <VersionItem
              key={v.id}
              v={v}
              previewing={v.id === previewId}
              readonly={readonly}
              onTogglePreview={onTogglePreview}
              onRestore={onRestore}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))}
          {versions.length > MAX_LIST_ITEMS && (
            <li className="bm-more">还有 {formatNumber(versions.length - MAX_LIST_ITEMS)} 条更早版本</li>
          )}
        </ul>
      )}

      {cleanOpen &&
        createPortal(
          <div className="modal-mask" onMouseDown={e => e.target === e.currentTarget && setCleanOpen(false)}>
            <div className="modal ver-clean" role="dialog" aria-label="清理历史版本">
              <div className="modal-title">清理历史版本</div>
              <div className="modal-body">
                <label className="ver-clean-row">
                  <input
                    type="radio"
                    checked={cleanMode === 'count'}
                    onChange={() => setCleanMode('count')}
                  />
                  保留最近
                  <input
                    className="input ver-num"
                    type="number"
                    min={1}
                    value={keepCount}
                    disabled={cleanMode !== 'count'}
                    onChange={e => setKeepCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  />
                  个版本
                </label>
                <label className="ver-clean-row">
                  <input
                    type="radio"
                    checked={cleanMode === 'days'}
                    onChange={() => setCleanMode('days')}
                  />
                  保留最近
                  <input
                    className="input ver-num"
                    type="number"
                    min={0}
                    value={keepDays}
                    disabled={cleanMode !== 'days'}
                    onChange={e => setKeepDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  />
                  天内版本
                </label>
                <label className="ver-clean-row">
                  <input
                    type="radio"
                    checked={cleanMode === 'all'}
                    onChange={() => setCleanMode('all')}
                  />
                  清理全部版本
                </label>
                <p className="ver-clean-preview">
                  将删除 {victims.length} 个版本，释放约 {formatBytes(freeBytes)}
                </p>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setCleanOpen(false)}>
                  取消
                </button>
                <button className="btn danger" disabled={victims.length === 0} onClick={runCleanup}>
                  清理
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
