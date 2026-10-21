import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AiConfig } from '../hooks/useAiConfig';
import type { FileTemplate, TemplateField, TemplateFieldType } from '../types';
import { MARKER_COLORS } from '../hooks/useFileBookmarks';
import { streamChat, type ApiChatMessage } from '../utils/aiClient';
import { buildAiContext } from '../utils/aiContext';
import {
  TEMPLATE_SYSTEM_PROMPT,
  fieldPreview,
  parseTemplateOutput,
} from '../utils/templateParser';
import { hexOffset } from '../utils/format';

/** 可编辑的字段行（解析结果 + 用户勾选/配色） */
interface FieldRow extends TemplateField {
  apply: boolean;
  color: string;
}

const FIELD_TYPE_OPTIONS: TemplateFieldType[] = [
  'uint8', 'uint16', 'uint32', 'uint64',
  'int8', 'int16', 'int32', 'int64',
  'float', 'double', 'string', 'timestamp', 'color', 'bytes',
];

const TYPE_LABELS: Record<TemplateFieldType, string> = {
  uint8: 'uint8', uint16: 'uint16', uint32: 'uint32', uint64: 'uint64',
  int8: 'int8', int16: 'int16', int32: 'int32', int64: 'int64',
  float: 'float32', double: 'float64', string: '字符串',
  timestamp: '时间戳', color: '颜色', bytes: '字节串',
};

export interface TemplateInput {
  /** 实际字节（含显示覆盖层，可能截断到 4KB） */
  bytes: Uint8Array;
  /** 数据起始绝对偏移 */
  start: number;
  /** 选中/取样的完整长度 */
  fullLength: number;
  truncated: boolean;
  fileSize: number;
}

interface AiTemplateDialogProps {
  input: TemplateInput;
  aiConfig: AiConfig;
  /** 当前文件已保存的模板 */
  templates: FileTemplate[];
  onSaveTemplate: (name: string, fields: TemplateField[]) => void;
  onDeleteTemplate: (id: string) => void;
  /** 应用所选字段（相对偏移由 FileTab 换算为绝对偏移后写入字段标记） */
  onApply: (fields: Array<TemplateField & { color: string }>) => void;
  /** 记录一次"描述 + AI 输出"到 AI 对话历史（保持会话完整） */
  onRecord: (description: string, output: string) => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}

/** AI 生成模板对话框：描述 → 流式 JSON → 字段预览/编辑 → 应用为字段标记（v1.1.5） */
export function AiTemplateDialog({
  input,
  aiConfig,
  templates,
  onSaveTemplate,
  onDeleteTemplate,
  onApply,
  onRecord,
  onClose,
  onToast,
}: AiTemplateDialogProps) {
  const [desc, setDesc] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<FieldRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [tplName, setTplName] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const recordedRef = useRef(false);

  // 卸载时中止未完成请求
  useEffect(() => () => abortRef.current?.abort(), []);

  const colorOf = (i: number) => MARKER_COLORS[i % MARKER_COLORS.length];

  const applyParsed = useCallback((text: string): boolean => {
    const res = parseTemplateOutput(text, input.bytes.length);
    if (res.ok && res.template) {
      setRows(res.template.fields.map((f, i) => ({ ...f, apply: true, color: colorOf(i) })));
      setTplName(res.template.name);
      setError(null);
      return true;
    }
    setError(res.error ?? '解析失败');
    setManualText(text);
    setRows(null);
    return false;
  }, [input.bytes.length]);

  /** 发起生成：专用 system prompt + 数据上下文，流式接收 */
  const generate = useCallback(async () => {
    const description = desc.trim();
    if (!description) {
      setError('请先用自然语言描述这段数据的格式');
      return;
    }
    if (!aiConfig.model.trim()) {
      setError('请先在 AI 配置中填写模型名称');
      return;
    }
    if (streaming) return;
    setStreaming(true);
    setRaw('');
    setRows(null);
    setError(null);
    recordedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const contextText = buildAiContext({
      bytes: input.bytes,
      start: input.start,
      fullLength: input.fullLength,
      truncated: input.truncated,
      title: '模板生成输入',
      cursorOffset: null,
      cursorByte: null,
      fileSize: input.fileSize,
    });
    const apiMessages: ApiChatMessage[] = [
      { role: 'system', content: TEMPLATE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${contextText}\n\n[格式描述]\n${description}`,
      },
    ];

    let acc = '';
    try {
      await streamChat(
        aiConfig,
        apiMessages,
        delta => {
          acc += delta;
          setRaw(acc);
        },
        controller.signal,
      );
      if (!acc) {
        setError('模型返回了空内容，请重试或调整描述');
        return;
      }
      if (applyParsed(acc)) {
        onRecord(description, acc);
        recordedRef.current = true;
      }
    } catch (err) {
      if (controller.signal.aborted) return; // 用户关闭对话框
      setError(err instanceof Error ? err.message : String(err));
      if (acc) setManualText(acc);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [desc, aiConfig, streaming, input, applyParsed, onRecord]);

  /** 手动修正后重新解析 */
  const reparse = useCallback(() => {
    if (applyParsed(manualText)) {
      if (!recordedRef.current) {
        onRecord(desc.trim() || '（手动修正 JSON）', manualText);
        recordedRef.current = true;
      }
    }
  }, [manualText, applyParsed, onRecord, desc]);

  const patchRow = (i: number, patch: Partial<FieldRow>) => {
    setRows(prev => (prev ? prev.map((r, j) => (j === i ? { ...r, ...patch } : r)) : prev));
  };

  const checked = rows?.filter(r => r.apply) ?? [];

  const loadTemplate = (id: string) => {
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    setRows(tpl.fields.map((f, i) => ({ ...f, apply: true, color: colorOf(i) })));
    setTplName(tpl.name);
    setError(null);
  };

  const saveTemplate = () => {
    if (checked.length === 0) {
      onToast('请先勾选要保存的字段');
      return;
    }
    onSaveTemplate(tplName || '未命名模板', checked.map(({ apply: _a, color: _c, ...f }) => f));
    onToast(`模板「${tplName || '未命名模板'}」已保存（${checked.length} 个字段）`);
  };

  return createPortal(
    <div className="modal-mask">
      <div className="modal tpl-dialog" role="dialog" aria-label="AI 生成模板">
        <div className="modal-title">AI 生成模板</div>
        <div className="modal-body tpl-body">
          <div className="tpl-input-meta">
            输入范围 0x{hexOffset(input.start, 8)} – 0x{hexOffset(input.start + input.fullLength - 1, 8)}
            （{input.fullLength} 字节{input.truncated ? `，已截断为前 ${input.bytes.length} 字节` : ''}）
          </div>
          <textarea
            className="input tpl-desc"
            rows={3}
            placeholder="用自然语言描述这段数据的格式，例如：头部 16 字节是魔数，接下来 4 字节小端是版本号，再 8 字节是时间戳…"
            value={desc}
            disabled={streaming}
            onChange={e => setDesc(e.target.value)}
          />
          <div className="tpl-actions">
            <button className="btn mini primary" disabled={streaming || !desc.trim()} onClick={() => void generate()}>
              {streaming ? '生成中…' : rows ? '重新生成' : '生成'}
            </button>
            {templates.length > 0 && (
              <select
                className="select tpl-load"
                value=""
                onChange={e => e.target.value && loadTemplate(e.target.value)}
                title="加载已保存的模板（当前文件的）"
              >
                <option value="">加载已有模板…</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.fields.length} 字段）
                  </option>
                ))}
              </select>
            )}
            <span className="tpl-flex" />
            {streaming && (
              <button className="btn mini" onClick={() => abortRef.current?.abort()}>
                停止
              </button>
            )}
          </div>

          {streaming && (
            <pre className="tpl-raw mono">{raw || '…'}</pre>
          )}

          {error && (
            <div className="tpl-error">
              <div className="side-error">{error}</div>
              <textarea
                className="input tpl-manual mono"
                rows={6}
                spellCheck={false}
                placeholder='修正 JSON 后点击"重新解析"。需要形如 {"name": "...", "fields": [{"name", "offset", "length", "type"}]}'
                value={manualText}
                onChange={e => setManualText(e.target.value)}
              />
              <button className="btn mini" onClick={reparse}>
                重新解析
              </button>
            </div>
          )}

          {rows && rows.length > 0 && (
            <>
              <div className="tpl-name-row">
                <span className="edit-label">模板名称</span>
                <input
                  className="input"
                  value={tplName}
                  onChange={e => setTplName(e.target.value)}
                  placeholder="未命名模板"
                />
              </div>
              <div className="tpl-table">
                <div className="tpl-tr tpl-th">
                  <span>应用</span>
                  <span>字段名</span>
                  <span>偏移</span>
                  <span>长度</span>
                  <span>类型</span>
                  <span>当前值</span>
                  <span>颜色</span>
                </div>
                {rows.map((r, i) => {
                  const abs = input.start + r.offset;
                  return (
                    <div key={i} className={`tpl-tr${r.apply ? '' : ' off'}`}>
                      <span>
                        <input
                          type="checkbox"
                          checked={r.apply}
                          onChange={e => patchRow(i, { apply: e.target.checked })}
                        />
                      </span>
                      <span>
                        <input
                          className="input tpl-cell"
                          value={r.name}
                          onChange={e => patchRow(i, { name: e.target.value })}
                        />
                      </span>
                      <span className="mono" title={`绝对偏移 0x${hexOffset(abs, 8)}`}>
                        0x{hexOffset(r.offset, 4)}
                      </span>
                      <span>
                        <input
                          className="input tpl-cell tpl-len"
                          type="number"
                          min={1}
                          value={r.length}
                          onChange={e => {
                            const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
                            patchRow(i, { length: Math.min(v, input.bytes.length - r.offset) });
                          }}
                        />
                      </span>
                      <span>
                        <select
                          className="select tpl-cell"
                          value={r.type}
                          onChange={e => patchRow(i, { type: e.target.value as TemplateFieldType })}
                        >
                          {FIELD_TYPE_OPTIONS.map(t => (
                            <option key={t} value={t}>
                              {TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span className="tpl-preview mono" title={r.description ?? ''}>
                        {fieldPreview(input.bytes, r)}
                      </span>
                      <span>
                        <span className="tpl-palette">
                          {MARKER_COLORS.map(c => (
                            <button
                              key={c}
                              className={`tpl-swatch${c === r.color ? ' on' : ''}`}
                              style={{ background: c }}
                              title={c}
                              onClick={() => patchRow(i, { color: c })}
                            />
                          ))}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="edit-hint">
                勾选 {checked.length}/{rows.length} 个字段 · 应用将在视图上以对应颜色标注字段范围（替换现有模板字段标记）
              </p>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button
            className="btn mini"
            disabled={rows === null || rows.length === 0}
            onClick={saveTemplate}
          >
            保存为模板
          </button>
          {templates.length > 0 && (
            <button
              className="btn mini danger"
              onClick={() => {
                const sel = templates[templates.length - 1];
                onDeleteTemplate(sel.id);
                onToast(`已删除模板「${sel.name}」`);
              }}
              title={`删除最近保存的模板（${templates[templates.length - 1]?.name ?? ''}）`}
            >
              删除模板
            </button>
          )}
          <span className="tpl-flex" />
          <button
            className="btn primary"
            disabled={checked.length === 0 || streaming}
            onClick={() => onApply(checked.map(({ apply: _a, ...rest }) => rest))}
          >
            应用所选（{checked.length}）
          </button>
          <button className="btn plain" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
