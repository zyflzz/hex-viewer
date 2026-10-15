import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiConfig, AiProvider } from '../hooks/useAiConfig';
import { AI_PROVIDER_URLS } from '../hooks/useAiConfig';
import type { ChatMessage } from '../hooks/useAiChat';
import { listOllamaModels } from '../utils/aiClient';
import { formatNumber, hexOffset } from '../utils/format';

const GUIDE_STORAGE_KEY = 'hex-viewer-ai-onboarded-v1';
/** 首次引导探测本地 Ollama 服务的超时（毫秒） */
const GUIDE_PROBE_TIMEOUT = 2500;

/** 快捷提问：填入输入框，用户可编辑后再发送（不限制提问范围） */
const QUICK_PROMPTS = [
  '这是什么文件',
  '这段字节有什么异常',
  '解码为文本',
  '可能的协议格式',
  '是否有加密特征',
];

/** 本地模型局限性说明：折叠时显示在顶部，展开时显示在提供方下方 */
const LIMIT_NOTE =
  '本地 7B 模型能力有限，仅供辅助参考，不保证准确。关键判断请自行验证或改用 API 模型。';

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

/** 轻量内容渲染：``` 代码块用 <pre>，其余按行 <p>（不引入 markdown 库） */
function renderContent(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split('```').forEach((part, i) => {
    if (i % 2 === 1) {
      // 代码块首行可能是语言标注，剥离后再展示
      const nl = part.indexOf('\n');
      const body = nl >= 0 && /^[\w.+-]*$/.test(part.slice(0, nl)) ? part.slice(nl + 1) : part;
      out.push(
        <pre key={`c${i}`} className="ai-code">
          {body.replace(/\n$/, '')}
        </pre>,
      );
    } else {
      part.split('\n').forEach((line, j) => {
        if (!line.trim()) return;
        out.push(
          <p key={`t${i}-${j}`} className="ai-line">
            {line}
          </p>,
        );
      });
    }
  });
  return out;
}

interface MessageItemProps {
  msg: ChatMessage;
  /** 该条正在流式生成（末尾显示闪烁光标） */
  streaming: boolean;
  digits: number;
}

/** 单条消息（memo：流式更新只重渲染内容变化的那条，其余消息跳过） */
const MessageItem = memo(function MessageItem({ msg, streaming, digits }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  if (msg.role === 'system') {
    return (
      <div className={`ai-msg system${msg.isError ? ' error' : ''}`}>
        <div className="ai-bubble">{msg.content}</div>
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const onCopy = async () => {
    await writeClipboard(msg.content);
    setCopied(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`ai-msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="ai-bubble">
        {msg.content ? renderContent(msg.content) : streaming ? null : <span className="ai-line">…</span>}
        {streaming && <span className="ai-caret-blink" />}
      </div>
      {isUser && msg.context && (
        <div className="ai-ctx mono" title="该提问附带的数据上下文">
          {msg.context.start === msg.context.end
            ? `@ 0x${hexOffset(msg.context.start, digits)}`
            : `0x${hexOffset(msg.context.start, digits)} – 0x${hexOffset(
                msg.context.end,
                digits,
              )} · ${formatNumber(msg.context.end - msg.context.start + 1)} 字节`}
          {msg.context.truncated ? ' · 已截断' : ''}
        </div>
      )}
      {!isUser && !streaming && msg.content && (
        <button className={`ai-copy${copied ? ' done' : ''}`} onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      )}
    </div>
  );
});

export interface SidebarAiProps {
  /** AI 选项卡是否激活（首次引导仅在实际打开时检测） */
  active: boolean;
  hasFile: boolean;
  config: AiConfig;
  onConfigChange: (patch: Partial<AiConfig>) => void;
  onResetSystemPrompt: () => void;
  messages: ChatMessage[];
  generating: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** 请求清空会话（App 层弹确认） */
  onClearRequest: () => void;
  /** 偏移位数（按文件大小自适应） */
  digits: number;
}

/**
 * AI 助手面板：配置区（可折叠）/ 会话控制 / 对话区（可滚动、流式展示）/ 输入区。
 * 只读助手——任何操作不改变编辑状态、选择、光标、书签与历史版本。
 */
export function SidebarAi(props: SidebarAiProps) {
  const {
    active,
    hasFile,
    config,
    onConfigChange,
    onResetSystemPrompt,
    messages,
    generating,
    onSend,
    onStop,
    onClearRequest,
    digits,
  } = props;

  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // 首次使用引导：无完成标记时展示，关闭后不再出现
  const [showGuide, setShowGuide] = useState(() => {
    try {
      return !localStorage.getItem(GUIDE_STORAGE_KEY);
    } catch {
      return false;
    }
  });
  const [guideStatus, setGuideStatus] = useState<'checking' | 'ok' | 'fail' | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const chatCount = useMemo(() => messages.filter(m => m.role !== 'system').length, [messages]);

  // 首次打开：探测本地 Ollama 服务（无论当前提供方，均按默认本地地址检测）
  useEffect(() => {
    if (!active || !showGuide || !hasFile) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), GUIDE_PROBE_TIMEOUT);
    setGuideStatus('checking');
    listOllamaModels(AI_PROVIDER_URLS.ollama, ctrl.signal)
      .then(() => {
        if (!cancelled) setGuideStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setGuideStatus('fail');
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [active, showGuide, hasFile]);

  // 自动滚动到底部；用户上滚查看历史时暂停，滚回底部或发送新消息后恢复
  useEffect(() => {
    if (!stickRef.current) return;
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, generating]);

  const onChatScroll = useCallback(() => {
    const el = chatRef.current;
    if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  }, []);

  const closeGuide = useCallback(() => {
    try {
      localStorage.setItem(GUIDE_STORAGE_KEY, '1');
    } catch {
      /* 忽略 */
    }
    setShowGuide(false);
  }, []);

  const refreshModels = useCallback(
    async (baseUrl: string) => {
      if (modelLoading) return;
      setModelLoading(true);
      setModelError(null);
      try {
        const list = await listOllamaModels(baseUrl);
        setModels(list);
        if (!list.length) setModelError('未发现已安装模型，可先在命令行执行 ollama pull 拉取');
      } catch (err) {
        setModelError(err instanceof Error ? err.message : String(err));
      } finally {
        setModelLoading(false);
      }
    },
    [modelLoading],
  );

  /** 切换提供方：地址为另一方默认值时同步切换，用户自定义地址保持不变 */
  const switchProvider = useCallback(
    (p: AiProvider) => {
      if (p === config.provider) return;
      const patch: Partial<AiConfig> = { provider: p };
      if (config.baseUrl === AI_PROVIDER_URLS[config.provider]) {
        patch.baseUrl = AI_PROVIDER_URLS[p];
      }
      onConfigChange(patch);
    },
    [config.provider, config.baseUrl, onConfigChange],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || generating || !hasFile) return;
    setDraft('');
    stickRef.current = true; // 发送新消息恢复自动滚动
    onSend(text);
  }, [draft, generating, hasFile, onSend]);

  /** 模型下拉选项：已拉取列表 + 当前值（未在列表中时补入，避免显示失真） */
  const modelOptions = useMemo(() => {
    const list = models ?? [];
    return config.model && !list.includes(config.model) ? [config.model, ...list] : list;
  }, [models, config.model]);

  if (!hasFile) {
    return (
      <div className="ai-root">
        <div className="ai-empty placeholder-text">打开文件后可用</div>
      </div>
    );
  }

  const lastId = messages.length ? messages[messages.length - 1].id : null;

  return (
    <div className="ai-root">
      {!configOpen && <div className="ai-hint">{LIMIT_NOTE}</div>}

      <div className="ai-config">
        <button
          className="ai-config-head"
          aria-expanded={configOpen}
          onClick={() => setConfigOpen(v => !v)}
        >
          <span>AI 配置</span>
          <span className={`ai-caret${configOpen ? ' open' : ''}`}>▶</span>
        </button>
        {configOpen && (
          <div className="ai-config-body">
            <div className="ai-field">
              <label>服务提供方</label>
              <div className="seg">
                <button
                  className={config.provider === 'ollama' ? 'on' : ''}
                  onClick={() => switchProvider('ollama')}
                >
                  本地 Ollama
                </button>
                <button
                  className={config.provider === 'openai' ? 'on' : ''}
                  onClick={() => switchProvider('openai')}
                >
                  OpenAI API
                </button>
              </div>
            </div>
            <div className="ai-note">{LIMIT_NOTE}</div>
            <div className="ai-field">
              <label>服务地址</label>
              <input
                className="input"
                value={config.baseUrl}
                spellCheck={false}
                placeholder={AI_PROVIDER_URLS[config.provider]}
                onChange={e => onConfigChange({ baseUrl: e.target.value })}
              />
            </div>
            <div className="ai-field">
              <label>模型</label>
              <div className="ai-model-row">
                {config.provider === 'ollama' ? (
                  <>
                    <select
                      className="select"
                      value={config.model}
                      onChange={e => onConfigChange({ model: e.target.value })}
                    >
                      {modelOptions.length ? (
                        modelOptions.map(m => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))
                      ) : (
                        <option value={config.model}>
                          {config.model || '（点击右侧刷新获取）'}
                        </option>
                      )}
                    </select>
                    <button
                      className="btn mini"
                      disabled={modelLoading}
                      title="从 Ollama 拉取已安装模型列表"
                      onClick={() => void refreshModels(config.baseUrl)}
                    >
                      {modelLoading ? '刷新中…' : '刷新'}
                    </button>
                  </>
                ) : (
                  <input
                    className="input"
                    value={config.model}
                    spellCheck={false}
                    placeholder="例如 gpt-4o-mini"
                    onChange={e => onConfigChange({ model: e.target.value })}
                  />
                )}
              </div>
              {modelError && config.provider === 'ollama' && (
                <div className="ai-field-err">{modelError}</div>
              )}
            </div>
            {config.provider === 'openai' && (
              <div className="ai-field">
                <label>API Key</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={config.apiKey}
                  placeholder="sk-…"
                  onChange={e => onConfigChange({ apiKey: e.target.value })}
                />
                <div className="ai-field-hint">明文保存在本地 localStorage，请勿在共享设备上使用</div>
              </div>
            )}
            <div className="ai-field">
              <label>
                系统 Prompt
                <button className="ai-restore" onClick={onResetSystemPrompt}>
                  恢复默认
                </button>
              </label>
              <textarea
                className="input ai-prompt"
                value={config.systemPrompt}
                rows={6}
                spellCheck={false}
                onChange={e => onConfigChange({ systemPrompt: e.target.value })}
              />
            </div>
            <div className="ai-field-row">
              <div className="ai-field">
                <label>上下文上限（字节）</label>
                <input
                  className="input"
                  type="number"
                  min={64}
                  max={4096}
                  step={64}
                  value={config.maxContextBytes}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) onConfigChange({ maxContextBytes: Math.round(v) });
                  }}
                  onBlur={() =>
                    onConfigChange({
                      maxContextBytes: Math.min(4096, Math.max(64, config.maxContextBytes)),
                    })
                  }
                />
              </div>
              <div className="ai-field">
                <label>温度</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={config.temperature}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) onConfigChange({ temperature: v });
                  }}
                  onBlur={() =>
                    onConfigChange({ temperature: Math.min(1, Math.max(0, config.temperature)) })
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="ai-session">
        <span className="ai-session-count">{chatCount > 0 ? `${chatCount} 条消息` : '空会话'}</span>
        <button className="btn mini" disabled={!messages.length} onClick={onClearRequest}>
          清空当前会话
        </button>
      </div>

      <div className="ai-chat" ref={chatRef} onScroll={onChatScroll}>
        {showGuide && (
          <div className="ai-guide">
            <div className="ai-guide-title">首次使用 AI 助手</div>
            <div className={`ai-guide-status${guideStatus ? ` ${guideStatus}` : ''}`}>
              {guideStatus === 'checking' && '正在检测本地 Ollama 服务…'}
              {guideStatus === 'ok' && '检测到本地 Ollama，可直接使用'}
              {guideStatus === 'fail' && '未检测到本地服务，请启动 Ollama 或改用 API 模式'}
            </div>
            <div className="ai-guide-btns">
              <button
                className="btn mini"
                disabled={modelLoading}
                onClick={() => void refreshModels(config.baseUrl)}
              >
                {modelLoading ? '刷新中…' : '刷新模型列表'}
              </button>
              <button className="btn mini" onClick={() => setConfigOpen(true)}>
                打开配置
              </button>
              <button className="btn mini" onClick={closeGuide}>
                知道了
              </button>
            </div>
          </div>
        )}
        {messages.length === 0 && !showGuide && (
          <div className="placeholder-text ai-chat-empty">
            选中一段字节后提问，AI 将基于其内容进行分析
          </div>
        )}
        {messages.map(m => (
          <MessageItem
            key={m.id}
            msg={m}
            streaming={generating && m.id === lastId && m.role === 'assistant'}
            digits={digits}
          />
        ))}
      </div>

      <div className="ai-input-area">
        <div className="ai-quick">
          {QUICK_PROMPTS.map(q => (
            <button
              key={q}
              className="btn mini"
              disabled={generating}
              onClick={() => {
                setDraft(q);
                taRef.current?.focus();
              }}
            >
              {q}
            </button>
          ))}
        </div>
        <textarea
          ref={taRef}
          className="input ai-input"
          value={draft}
          rows={3}
          placeholder={generating ? '生成中…' : '输入问题，Enter 发送'}
          disabled={generating}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter 发送，Shift+Enter 换行；输入法组词期间不触发
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="ai-input-foot">
          <span className="ai-input-hint">
            {generating ? '正在生成…' : 'Enter 发送 · Shift+Enter 换行'}
          </span>
          {generating ? (
            <button className="btn mini" onClick={onStop}>
              停止生成
            </button>
          ) : (
            <button className="btn mini primary" disabled={!draft.trim()} onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
