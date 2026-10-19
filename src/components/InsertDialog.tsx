import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { hexOffset } from '../utils/format';
import { encodeTextToBytes, parseHexPattern } from '../utils/hexParse';
import type { TextEncoding } from '../types';

/** 单次插入的字节上限（与 Rust 追加缓冲协同，防止一次注入过大内存） */
const MAX_INSERT_BYTES = 16 * 1024 * 1024;

/** 文件模式候选文件的元信息（打开预览用） */
interface PickedFile {
  path: string;
  name: string;
  size: number;
}

interface InsertDialogProps {
  /** 插入点（虚拟偏移，新字节插在该偏移之前） */
  offset: number;
  digits: number;
  encoding: TextEncoding;
  onCommit: (bytes: number[], source: string) => void;
  onCancel: () => void;
}

/**
 * 插入字节对话框（v1.1.4）：Hex 输入 / 按显示编码的文本 / 从文件插入。
 * 新字节插入在指定偏移之前；点外部不关闭，须明确插入/取消。
 */
export function InsertDialog({ offset, digits, encoding, onCommit, onCancel }: InsertDialogProps) {
  const [mode, setMode] = useState<'hex' | 'text' | 'file'>('hex');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  // 焦点不在输入框时 Escape 也能取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /** 当前输入解析出的字节（无效返回 null；file 模式提交时读取，不在此解析） */
  const parsed: Uint8Array | null = (() => {
    if (mode === 'hex') {
      const bytes = parseHexPattern(text);
      return bytes && bytes.length > 0 ? bytes : null;
    }
    if (mode === 'text') {
      if (!text) return null;
      const bytes = encodeTextToBytes(text, encoding);
      return bytes.length > 0 ? bytes : null;
    }
    return null;
  })();

  const tooLarge = parsed !== null && parsed.length > MAX_INSERT_BYTES;

  const pickFile = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      });
      if (!selected) return;
      const meta = await invoke<{ name: string; size: number }>('get_file_meta', {
        path: selected as string,
      }).catch(() => null);
      if (!meta) {
        setError('无法读取该文件');
        return;
      }
      if (meta.size > MAX_INSERT_BYTES) {
        setError(`文件过大（${meta.size} 字节），插入上限 ${MAX_INSERT_BYTES / 1024 / 1024}MB`);
        return;
      }
      setError(null);
      setPicked({ path: selected as string, name: meta.name, size: meta.size });
    } catch (err) {
      setError(`选择文件失败: ${err}`);
    }
  };

  const commit = async () => {
    setError(null);
    if (mode === 'file') {
      if (!picked) return;
      try {
        // 以独立命令读取文件内容（不占用标签页句柄；上限已在选择时校验）
        const data = await invoke<number[]>('read_file_bytes', { path: picked.path, maxLen: MAX_INSERT_BYTES });
        if (data.length === 0) {
          setError('文件为空');
          return;
        }
        onCommit(data, `文件 ${picked.name}`);
      } catch (err) {
        setError(`读取文件失败: ${err}`);
      }
      return;
    }
    if (!parsed || tooLarge) return;
    onCommit(Array.from(parsed), mode === 'hex' ? 'Hex' : `${encoding} 文本`);
  };

  return createPortal(
    <div className="modal-mask">
      <div className="modal edit-dialog" role="dialog" aria-label="插入字节">
        <div className="modal-title">插入字节</div>
        <div className="modal-body">
          <div className="edit-row">
            <span className="edit-label">插入点</span>
            <span className="mono">{hexOffset(offset, digits)}（新字节插在此偏移之前）</span>
          </div>
          <div className="edit-row">
            <span className="edit-label">来源</span>
            <div className="seg">
              <button className={mode === 'hex' ? 'on' : ''} onClick={() => setMode('hex')}>
                Hex
              </button>
              <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
                文本
              </button>
              <button className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
                文件
              </button>
            </div>
          </div>
          {mode === 'hex' && (
            <div className="edit-row">
              <span className="edit-label">Hex 内容</span>
              <input
                ref={inputRef}
                className="edit-input mono"
                value={text}
                placeholder="如 48 65 6C 6C 6F 或 48656C6C6F"
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && parsed && !tooLarge) void commit();
                }}
              />
            </div>
          )}
          {mode === 'text' && (
            <div className="edit-row">
              <span className="edit-label">文本内容</span>
              <input
                ref={inputRef}
                className="edit-input mono"
                value={text}
                placeholder={`按 ${encoding} 编码为字节插入`}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && parsed && !tooLarge) void commit();
                }}
              />
            </div>
          )}
          {mode === 'file' && (
            <div className="edit-row">
              <span className="edit-label">选择文件</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <button className="btn mini" onClick={() => void pickFile()}>
                  浏览…
                </button>
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {picked ? `${picked.name}（${picked.size} 字节）` : '未选择'}
                </span>
              </div>
            </div>
          )}
          {mode === 'hex' && parsed === null && text.trim() !== '' && (
            <p className="side-error">不是有效的 Hex 字符串</p>
          )}
          {mode === 'text' && parsed === null && text !== '' && (
            <p className="side-error">文本无法编码为字节</p>
          )}
          {tooLarge && (
            <p className="side-error">内容过大（上限 {MAX_INSERT_BYTES / 1024 / 1024}MB）</p>
          )}
          {error && <p className="side-error">{error}</p>}
          {parsed !== null && !tooLarge && (
            <p className="edit-hint">将插入 {parsed.length} 字节（可 Ctrl+Z 撤销）</p>
          )}
        </div>
        <div className="modal-actions">
          <button
            className="btn primary"
            disabled={
              (mode !== 'file' && (parsed === null || tooLarge)) || (mode === 'file' && !picked)
            }
            onClick={() => void commit()}
          >
            插入
          </button>
          <button className="btn plain" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
