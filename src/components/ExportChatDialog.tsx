import { useState } from 'react';
import { createPortal } from 'react-dom';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { FileMeta } from '../types';
import type { ChatMessage } from '../hooks/useAiChat';
import { chatExportBaseName, toJson, toMarkdown } from '../utils/chatExport';

interface ExportChatDialogProps {
  meta: FileMeta;
  messages: ChatMessage[];
  onClose: () => void;
  onToast: (msg: string) => void;
}

/** AI 会话导出对话框：格式选择 + 上下文/系统消息取舍 + 保存路径（v1.1.5） */
export function ExportChatDialog({ meta, messages, onClose, onToast }: ExportChatDialogProps) {
  const [format, setFormat] = useState<'markdown' | 'json'>('markdown');
  const [includeContext, setIncludeContext] = useState(true);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [collapseContext, setCollapseContext] = useState(true);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const options = { includeContext, includeSystem, collapseContext };
      const content =
        format === 'markdown'
          ? toMarkdown(meta, messages, options)
          : toJson(meta, messages, options);
      const ext = format === 'markdown' ? 'md' : 'json';
      const target = await saveFileDialog({
        defaultPath: `${chatExportBaseName(meta)}.${ext}`,
        filters:
          format === 'markdown'
            ? [
                { name: 'Markdown 文档', extensions: ['md'] },
                { name: '所有文件', extensions: ['*'] },
              ]
            : [
                { name: 'JSON 文档', extensions: ['json'] },
                { name: '所有文件', extensions: ['*'] },
              ],
      });
      if (!target) return;
      await invoke('write_text_file', { path: target, content });
      const name = (target as string).split(/[\\/]/).pop() ?? target;
      onToast(`已导出会话到 ${name}`);
      onClose();
    } catch (err) {
      onToast(`导出失败: ${err}`);
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-mask">
      <div className="modal edit-dialog" role="dialog" aria-label="导出 AI 会话">
        <div className="modal-title">导出 AI 会话</div>
        <div className="modal-body">
          <div className="edit-row">
            <span className="edit-label">格式</span>
            <div className="seg">
              <button className={format === 'markdown' ? 'on' : ''} onClick={() => setFormat('markdown')}>
                Markdown
              </button>
              <button className={format === 'json' ? 'on' : ''} onClick={() => setFormat('json')}>
                JSON
              </button>
            </div>
          </div>
          <div className="edit-row">
            <span className="edit-label">数据上下文</span>
            <label className="chk-label">
              <input
                type="checkbox"
                checked={includeContext}
                onChange={e => setIncludeContext(e.target.checked)}
              />
              包含用户消息附带的 HEX 上下文
            </label>
          </div>
          {format === 'markdown' && (
            <div className="edit-row">
              <span className="edit-label">折叠显示</span>
              <label className="chk-label">
                <input
                  type="checkbox"
                  checked={collapseContext}
                  disabled={!includeContext}
                  onChange={e => setCollapseContext(e.target.checked)}
                />
                数据上下文用可折叠块包裹
              </label>
            </div>
          )}
          <div className="edit-row">
            <span className="edit-label">系统消息</span>
            <label className="chk-label">
              <input
                type="checkbox"
                checked={includeSystem}
                onChange={e => setIncludeSystem(e.target.checked)}
              />
              包含系统提示与错误消息
            </label>
          </div>
          <p className="edit-hint">
            将导出当前文件会话的 {messages.length} 条消息（Markdown 保留代码块，JSON 保留完整字段）
          </p>
        </div>
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || messages.length === 0} onClick={() => void confirm()}>
            {busy ? '导出中…' : '选择位置并导出'}
          </button>
          <button className="btn plain" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
