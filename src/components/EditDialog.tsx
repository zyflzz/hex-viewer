import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hexByte, hexOffset } from '../utils/format';

interface EditDialogProps {
  start: number;
  end: number;
  /** 偏移显示位数（与主视图一致） */
  digits: number;
  /** 读取区间当前内容（含未保存编辑），失败时由调用方决定回退 */
  loadBytes: () => Promise<Uint8Array>;
  onCommit: (newBytes: Uint8Array) => void;
  onCancel: () => void;
}

function hexPreview(bytes: Uint8Array, max: number): string {
  const parts: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i++) parts.push(hexByte(bytes[i]));
  return parts.join(' ') + (bytes.length > max ? ` …（共 ${bytes.length} 字节）` : '');
}

/** 对话框编辑：显示区间与当前值，输入等长 Hex 替换整个区间。点外部不关闭，须明确确认/取消 */
export function EditDialog({ start, end, digits, loadBytes, onCommit, onCancel }: EditDialogProps) {
  const [current, setCurrent] = useState<Uint8Array | null>(null);
  const [text, setText] = useState('');
  const textRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    loadBytes()
      .then(b => {
        if (alive) setCurrent(b);
      })
      .catch(() => {
        if (alive) setCurrent(new Uint8Array(end - start + 1));
      });
    return () => {
      alive = false;
    };
  }, [loadBytes, start, end]);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  // 焦点不在输入框时（如点了弹窗按钮）Escape 也能取消；输入框内的 Escape 由其自身 stopPropagation 处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const len = end - start + 1;
  // 只保留 Hex 字符，要求恰好 2*len 位
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  const valid = clean.length === len * 2;

  const commit = () => {
    if (!valid || !current) return;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    onCommit(out);
  };

  return createPortal(
    <div className="modal-mask">
      <div className="modal edit-dialog" role="dialog" aria-label="编辑字节">
        <div className="modal-title">编辑字节</div>
        <div className="modal-body">
          <div className="edit-row">
            <span className="edit-label">区间</span>
            <span className="mono">
              {hexOffset(start, digits)} – {hexOffset(end, digits)}（{len} 字节）
            </span>
          </div>
          <div className="edit-row">
            <span className="edit-label">当前值</span>
            <span className="mono edit-current">
              {current ? hexPreview(current, 64) : '加载中…'}
            </span>
          </div>
          <div className="edit-row column">
            <span className="edit-label">新值（Hex）</span>
            <textarea
              ref={textRef as never}
              className="edit-input mono"
              value={text}
              spellCheck={false}
              placeholder={`Hex 字符，长度 ${len * 2} 位（如 48656C6C6F，可含空格）`}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  onCancel();
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  commit();
                }
              }}
            />
            <div className={`edit-hint${clean.length > 0 && !valid ? ' err' : ''}`}>
              {clean.length === 0
                ? `待输入 ${len * 2} 个 Hex 字符`
                : valid
                  ? '格式正确'
                  : `已输入 ${clean.length} / ${len * 2} 个 Hex 字符`}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!valid || !current} onClick={commit}>
            替换
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
