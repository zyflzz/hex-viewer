import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmButton {
  label: string;
  kind?: 'primary' | 'danger' | 'plain';
  onClick: () => void;
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  buttons: ConfirmButton[];
  /** Escape 触发（通常绑定"取消"类按钮） */
  onCancel?: () => void;
}

/** 通用确认弹窗：未保存三选一 / 保存前确认 / 放弃修改确认 */
export function ConfirmDialog({ title, message, buttons, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-mask">
      <div className="modal confirm-dialog" role="alertdialog" aria-label={title}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          {buttons.map(b => (
            <button key={b.label} className={`btn ${b.kind ?? ''}`} onClick={b.onClick}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
