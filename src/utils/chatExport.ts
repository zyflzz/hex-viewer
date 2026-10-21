/**
 * AI 会话导出（v1.1.5）：Markdown / JSON 两种格式的纯函数。
 * 只读现有会话数据，不改变任何状态。
 */
import type { FileMeta } from '../types';
import type { ChatMessage } from '../hooks/useAiChat';
import { formatBytes } from './format';

export interface ChatExportOptions {
  /** 是否包含每条用户消息附带的数据上下文（HEX 片段 + 解码结果） */
  includeContext: boolean;
  /** 是否包含系统提示与错误消息 */
  includeSystem: boolean;
  /** 仅 Markdown：数据上下文用可折叠块（<details>）包裹 */
  collapseContext: boolean;
}

/** 导出用元信息 */
export interface ChatExportMeta {
  path: string;
  name: string;
  size: number;
}

/** 导出范围内可见的消息（时间升序） */
function visibleMessages(messages: ChatMessage[], options: ChatExportOptions): ChatMessage[] {
  return messages
    .filter(m => (options.includeSystem ? true : m.role !== 'system'))
    .sort((a, b) => a.time - b.time);
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

/** Markdown：头部元信息 + 按时间顺序逐条消息 */
export function toMarkdown(
  meta: ChatExportMeta,
  messages: ChatMessage[],
  options: ChatExportOptions,
): string {
  const list = visibleMessages(messages, options);
  const first = list[0]?.time;
  const last = list[list.length - 1]?.time;
  const lines: string[] = [
    '# AI 会话导出',
    '',
    `- 文件: ${meta.name}`,
    `- 路径: ${meta.path}`,
    `- 大小: ${formatBytes(meta.size)}（${meta.size} 字节）`,
    `- 消息数: ${list.length}`,
    `- 时间: ${first ? fmtTime(first) : '-'} ~ ${last ? fmtTime(last) : '-'}`,
    '',
    '---',
    '',
  ];

  for (const m of list) {
    const time = fmtTime(m.time);
    if (m.role === 'user') {
      lines.push(`> **用户**（${time}）`);
      for (const l of m.content.split('\n')) lines.push(`> ${l}`);
      lines.push('');
      if (options.includeContext && m.contextText) {
        const range = m.context
          ? `0x${m.context.start.toString(16)} – 0x${m.context.end.toString(16)}，${m.context.end - m.context.start + 1} 字节${m.context.truncated ? '，已截断' : ''}`
          : '数据上下文';
        if (options.collapseContext) {
          lines.push(`<details><summary>${range}（点击展开数据上下文）</summary>`, '');
        } else {
          lines.push(`**${range}**`, '');
        }
        lines.push('```text', m.contextText, '```', '');
        if (options.collapseContext) lines.push('</details>', '');
      }
    } else if (m.role === 'assistant') {
      lines.push(`**助手**（${time}）`, '', m.content, '');
    } else {
      // 系统提示 / 错误消息：斜体引用行
      lines.push(`> *系统（${time}）${m.content}*`, '');
    }
  }
  return lines.join('\n');
}

/** JSON 导出的完整结构（保留 context / contextText 原字段） */
export interface ChatExportJson {
  exportedAt: number;
  file: { path: string; name: string; size: number };
  messageCount: number;
  messages: ChatMessage[];
}

export function toJson(
  meta: ChatExportMeta,
  messages: ChatMessage[],
  options: ChatExportOptions,
): string {
  const list = visibleMessages(messages, options);
  const payload: ChatExportJson = {
    exportedAt: Date.now(),
    file: { path: meta.path, name: meta.name, size: meta.size },
    messageCount: list.length,
    messages: list,
  };
  return JSON.stringify(payload, null, 2);
}

/** 导出文件默认名（不含扩展名） */
export function chatExportBaseName(meta: FileMeta | null): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  const base = meta?.name ? meta.name.replace(/[\\/:*?"<>|]/g, '_') : '未命名';
  return `会话-${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
