import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { BackupInfo, FileMeta } from '../types';
import { formatBytes, formatDateTime } from '../utils/format';

interface BackupRestoreDialogProps {
  meta: FileMeta;
  onClose: () => void;
  /** 用户选中一份备份（FileTab 弹确认后执行恢复） */
  onRestore: (backupName: string) => void;
  onToast: (msg: string) => void;
}

/** 从备份恢复：列出当前文件的滚动备份（文件名 + 修改时间 + 大小），点击选择（v1.1.5） */
export function BackupRestoreDialog({ meta, onClose, onRestore, onToast }: BackupRestoreDialogProps) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<BackupInfo[]>('list_backups', { path: meta.path })
      .then(list => {
        if (!cancelled) setBackups(list);
      })
      .catch(err => {
        if (!cancelled) {
          setBackups([]);
          onToast(`读取备份列表失败: ${err}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path, onToast]);

  return createPortal(
    <div className="modal-mask">
      <div className="modal edit-dialog bak-dialog" role="dialog" aria-label="从备份恢复">
        <div className="modal-title">从备份恢复</div>
        <div className="modal-body">
          <p className="edit-hint">
            当前文件：<span className="mono">{meta.name}</span>
            <br />
            点击一份备份后确认，将用它覆盖当前文件（恢复前当前内容也会先归档一份）。
          </p>
          {backups === null ? (
            <p className="placeholder-text">正在读取备份列表…</p>
          ) : backups.length === 0 ? (
            <p className="placeholder-text">
              暂无可用备份。备份在保存时自动创建（编辑选项卡可配置），当前内容被覆盖前会滚动保留若干份。
            </p>
          ) : (
            <ul className="bak-list">
              {backups.map((b, i) => (
                <li key={b.name}>
                  <button
                    className="bak-item"
                    title="用这份备份覆盖当前文件"
                    onClick={() => onRestore(b.name)}
                  >
                    <span className={`bak-tag${i === 0 ? ' newest' : ''}`}>{i === 0 ? '最新' : `#${i}`}</span>
                    <span className="bak-name mono">{b.name}</span>
                    <span className="bak-meta">
                      {formatDateTime(b.modified)} · {formatBytes(b.size)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn plain" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
