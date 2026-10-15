import type { AiConfig } from '../hooks/useAiConfig';

/** 发给模型的对话消息（OpenAI / Ollama 通用结构） */
export interface ApiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 前端直接 fetch：Ollama 与 OpenAI 兼容接口均为标准 HTTP JSON，
 * Tauri WebView 不做同源限制，且两端服务默认放行跨域，无需 Rust 侧代理。
 */

/** 拉取 Ollama 已安装模型列表（GET /api/tags） */
export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/tags`, { signal });
  if (!res.ok) throw new Error(`获取模型列表失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
}

function httpError(provider: AiConfig['provider'], status: number, detail: string): Error {
  const tail = detail ? `：${detail.slice(0, 200)}` : '';
  switch (status) {
    case 401:
      return new Error(`API Key 无效或未授权（HTTP 401）${tail}`);
    case 403:
      return new Error(`访问被拒绝（HTTP 403）${tail}`);
    case 404:
      return new Error(
        provider === 'ollama'
          ? `服务地址错误或接口不存在（HTTP 404），请检查服务地址${tail}`
          : `模型不存在或接口地址错误（HTTP 404）${tail}`,
      );
    case 400:
      return new Error(`请求被拒绝（HTTP 400），可能是上下文超长，可调小「上下文最大字节数」重试${tail}`);
    default:
      return new Error(`服务错误（HTTP ${status}）${tail}`);
  }
}

/** 读取流式响应：Ollama 为 NDJSON（每行一个 JSON），OpenAI 为 SSE（data: {...}） */
async function readStream(
  provider: AiConfig['provider'],
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    try {
      if (provider === 'openai') {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        const delta = (
          JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
        ).choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) onDelta(delta);
      } else {
        const obj = JSON.parse(line) as {
          message?: { content?: string };
          error?: unknown;
        };
        if (obj.error) {
          throw new Error(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
        }
        const content = obj.message?.content;
        if (typeof content === 'string' && content) onDelta(content);
      }
    } catch (err) {
      // 自身抛出的业务错误继续上抛；JSON 解析失败（心跳/杂项行）静默忽略
      if (err instanceof Error && !(err instanceof SyntaxError)) throw err;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
  } finally {
    reader.releaseLock();
  }
}

/**
 * 流式对话：统一封装 Ollama（POST /api/chat，NDJSON）与
 * OpenAI 兼容（POST /v1/chat/completions，SSE）两种提供方，
 * 对外为回调式流；异常（含用户中止 AbortError）原样抛出。
 */
export async function streamChat(
  cfg: AiConfig,
  messages: ApiChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const base = normalizeBase(cfg.baseUrl);
  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (cfg.provider === 'ollama') {
    url = `${base}/api/chat`;
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      options: { temperature: cfg.temperature },
    });
  } else {
    // OpenAI 兼容：默认根路径自动补 /v1，已带版本号则保持
    const apiRoot = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    url = `${apiRoot}/chat/completions`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
    body = JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature,
    });
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error('无法连接到 AI 服务，请确认服务已启动，并检查配置中的服务地址');
  }

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string };
        detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? text);
      } catch {
        detail = text;
      }
    } catch {
      /* 忽略错误体读取失败 */
    }
    throw httpError(cfg.provider, res.status, detail);
  }
  if (!res.body) throw new Error('服务未返回数据流');
  await readStream(cfg.provider, res.body, onDelta);
}
