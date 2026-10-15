import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hexOffset } from '../utils/format';

interface FillDialogProps {
  start: number;
  end: number;
  /** 偏移显示位数（与主视图一致） */
  digits: number;
  onCommit: (value: number) => void;
  onCancel: () => void;
}

const PRESETS = [
  ['00', '零填充'],
  ['FF', '全 1（FF）'],
  ['CC', '0xCC（int8 = -52）'],
  ['AA', '0xAA（10101010）'],
] as const;

/** 填充对话框：把选中区间全部写为同一字节值（两位 Hex） */
export function FillDialog({ start, end, digits, onCommit, onCancel }: FillDialogProps) {
  const [text, setText] = useState('00');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Escape 关闭（含焦点不在输入框时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const clean = text.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const valid = clean.length === 2;
  const len = end - start + 1;

  const commit = () => {
    if (!valid) return;
    onCommit(parseInt(clean, 16));
  };

  return createPortal(
    <div className="modal-mask">
      <div className="modal fill-dialog" role="dialog" aria-label="填充字节">
        <div className="modal-title">填充区间</div>
        <div className="modal-body">
          <div className="edit-row">
            <span className="edit-label">区间</span>
            <span className="mono">
              {hexOffset(start, digits)} – {hexOffset(end, digits)}（{len} 字节）
            </span>
          </div>
          <div className="edit-row column">
            <span className="edit-label">填充值（Hex）</span>
            <input
              ref={inputRef}
              className="input mono fill-input"
              value={text}
              maxLength={2}
              spellCheck={false}
              placeholder="如 00 / FF"
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  onCancel();
                } else if (e.key === 'Enter') {
                  commit();
                }
              }}
            />
            <div className="fill-presets">
              {PRESETS.map(([v, tip]) => (
                <button
                  key={v}
                  className={`btn mini${clean === v ? ' on' : ''}`}
                  style={{ marginLeft: 0 }}
                  title={tip}
                  onClick={() => {
                    setText(v);
                    inputRef.current?.focus();
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className={`edit-hint${clean.length > 0 && !valid ? ' err' : ''}`}>
              {clean.length === 0
                ? '输入两位 Hex 字符'
                : valid
                  ? `将把 ${len} 字节填充为 0x${clean}`
                  : `需两位 Hex 字符（已输入 ${clean.length} 位）`}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={commit}>
            填充
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
