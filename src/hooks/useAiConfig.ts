import { useCallback, useEffect, useState } from 'react';

/** AI 服务提供方：本地 Ollama / OpenAI 兼容 API */
export type AiProvider = 'ollama' | 'openai';

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  /** 选中内容注入上下文的最大字节数（64–4096），超出截断 */
  maxContextBytes: number;
  /** 采样温度（0–1），Coder 类模型低温度输出更稳 */
  temperature: number;
}

/** 各提供方默认服务地址 */
export const AI_PROVIDER_URLS: Record<AiProvider, string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com/v1',
};

export const DEFAULT_AI_SYSTEM_PROMPT = `你是一个十六进制编辑器中的二进制数据分析助手。用户会提供一段字节序列（含 HEX、ASCII 表示与可能的文本解码结果）并提问。

你的职责：
- 分析这段字节可能是什么格式（文件头/魔数、协议字段、数据结构等）
- 指出可疑或异常之处（加密/压缩特征、填充、异常的字节分布等）
- 按用户要求尝试解读文本内容

回答要求：
- 使用中文，简洁、结构化，先给结论再给依据
- 只基于给出的字节内容推断，明确区分「确定」与「猜测」
- 不确定时直说不确定，并给出可行的验证方法
- 你只能输出分析文字，不能执行任何操作；如需修改数据，提醒用户自行在编辑器中完成`;

const STORAGE_KEY = 'hex-viewer-ai-config-v1';

const DEFAULT_CONFIG: AiConfig = {
  provider: 'ollama',
  baseUrl: AI_PROVIDER_URLS.ollama,
  model: 'qwen2.5-coder:7b',
  apiKey: '',
  systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  maxContextBytes: 512,
  temperature: 0.3,
};

function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw) as Partial<AiConfig>;
    const provider: AiProvider = p.provider === 'openai' ? 'openai' : 'ollama';
    const mcb = typeof p.maxContextBytes === 'number' ? Math.round(p.maxContextBytes) : NaN;
    const temp = typeof p.temperature === 'number' ? p.temperature : NaN;
    return {
      provider,
      baseUrl:
        typeof p.baseUrl === 'string' && p.baseUrl.trim()
          ? p.baseUrl
          : AI_PROVIDER_URLS[provider],
      model: typeof p.model === 'string' ? p.model : DEFAULT_CONFIG.model,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      systemPrompt:
        typeof p.systemPrompt === 'string' ? p.systemPrompt : DEFAULT_AI_SYSTEM_PROMPT,
      maxContextBytes: Number.isFinite(mcb)
        ? Math.min(4096, Math.max(64, mcb))
        : DEFAULT_CONFIG.maxContextBytes,
      temperature: Number.isFinite(temp)
        ? Math.min(1, Math.max(0, temp))
        : DEFAULT_CONFIG.temperature,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * AI 配置（提供方/地址/模型/Key/系统提示/上下文上限/温度）。
 * 全局偏好（与文件无关），持久化到 localStorage。
 * 不做过多校验：用户填什么用什么，出错时以系统消息形式反馈。
 */
export function useAiConfig() {
  const [config, setConfig] = useState<AiConfig>(loadConfig);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* 忽略持久化失败 */
    }
  }, [config]);

  const updateConfig = useCallback((patch: Partial<AiConfig>) => {
    setConfig(c => ({ ...c, ...patch }));
  }, []);

  const resetSystemPrompt = useCallback(() => {
    setConfig(c => ({ ...c, systemPrompt: DEFAULT_AI_SYSTEM_PROMPT }));
  }, []);

  return { config, updateConfig, resetSystemPrompt };
}
