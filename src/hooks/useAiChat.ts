import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileMeta } from '../types';

/**
 * 对话消息：
 * - user：用户提问（contextText 为发给模型的数据上下文，展示时隐藏）
 * - assistant：AI 回复（流式期间由 updateMessage 增量更新）
 * - system：系统提示/错误信息（不发送给模型）
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  time: number;
  /** 发送给模型的数据上下文文本（仅用户消息） */
  contextText?: string;
  /** 关联的数据范围（选中区间 / 光标附近），仅用户消息有 */
  context?: { start: number; end: number; truncated: boolean };
  /** 系统错误消息标记 */
  isError?: boolean;
}

const STORAGE_KEY = 'hex-viewer-ai-chat-v1';
/** 单文件消息上限（用户 + AI 混合计数，超出删最旧） */
const MAX_MESSAGES = 100;
/** 保留历史的文件数上限（按最近使用淘汰） */
const MAX_FILES = 32;
/** 流式期间写盘防抖（毫秒），避免每个增量都触发 localStorage 写入 */
const SAVE_DEBOUNCE_MS = 500;

/** 全局存储结构：{ [文件路径]: Message[] }；文件最近使用时间取最后一条消息的时间 */
type ChatStore = Record<string, ChatMessage[]>;

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as ChatMessage;
  return (
    typeof m.id === 'string' &&
    (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
    typeof m.content === 'string' &&
    typeof m.time === 'number'
  );
}

function loadStore(): ChatStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const store: ChatStore = {};
    for (const [path, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) {
        const valid = list.filter(isChatMessage);
        if (valid.length) store[path] = valid.slice(-MAX_MESSAGES);
      }
    }
    return store;
  } catch {
    return {};
  }
}

function lastTime(msgs: ChatMessage[] | undefined): number {
  return msgs?.[msgs.length - 1]?.time ?? 0;
}

/** 写盘：文件数 LRU 淘汰 + 配额不足时渐进丢弃最旧文件重试 */
function saveStore(store: ChatStore) {
  const paths = Object.keys(store);
  if (paths.length > MAX_FILES) {
    const byOldest = paths.sort((a, b) => lastTime(store[a]) - lastTime(store[b]));
    for (const p of byOldest.slice(0, paths.length - MAX_FILES)) delete store[p];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 配额不足：丢弃最旧的文件后重试（递归有界：最多淘汰到剩 1 个文件）
    const rest = Object.keys(store);
    if (rest.length > 1) {
      rest.sort((a, b) => lastTime(store[a]) - lastTime(store[b]));
      delete store[rest[0]];
      saveStore(store);
    }
    /* 仍失败则静默放弃本轮持久化 */
  }
}

function commit(path: string, msgs: ChatMessage[]) {
  const store = loadStore();
  if (msgs.length) store[path] = msgs.slice(-MAX_MESSAGES);
  else delete store[path];
  saveStore(store);
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * AI 对话历史：按文件路径持久化到 localStorage。
 * 切换文件自动加载对应历史；写入防抖，流式更新只在停顿时落盘。
 */
export function useAiChat(fileMeta: FileMeta | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const path = fileMeta?.path ?? null;
  const pendingRef = useRef<{ path: string; msgs: ChatMessage[] } | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 有未落盘的用户变更（防止加载前的空状态覆盖已有历史） */
  const dirtyRef = useRef(false);

  // 文件切换：加载该文件的对话历史（新文件为空会话）
  useEffect(() => {
    if (!path) {
      setMessages([]);
      return;
    }
    setMessages(loadStore()[path] ?? []);
  }, [path]);

  // 变更防抖写盘；切换文件时先把上一文件的未写变更落盘（避免旧消息写到新路径）。
  // 脏标记：仅在发生用户可见的变更后才允许落盘——防止把「加载前的空消息」写回
  // 而误删该文件已有历史（StrictMode 双挂载 / 极速卸载场景）。
  useEffect(() => {
    if (!path) return;
    const pending = pendingRef.current;
    if (pending && pending.path !== path && dirtyRef.current) {
      commit(pending.path, pending.msgs);
      dirtyRef.current = false;
    }
    pendingRef.current = { path, msgs: messages };
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const p = pendingRef.current;
      if (p && dirtyRef.current) {
        commit(p.path, p.msgs);
        dirtyRef.current = false;
      }
      pendingRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  }, [messages, path]);

  // 卸载时落盘未写变更
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      const p = pendingRef.current;
      if (p && dirtyRef.current) {
        commit(p.path, p.msgs);
        dirtyRef.current = false;
      }
    },
    [],
  );

  /** 追加消息，返回消息 id（供流式更新定位） */
  const appendMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'time'>): string => {
    const id = newId();
    dirtyRef.current = true;
    setMessages(prev => [...prev, { ...msg, id, time: Date.now() }]);
    return id;
  }, []);

  /** 更新消息内容（流式增量 / 空回复占位） */
  const updateMessage = useCallback((id: string, content: string) => {
    dirtyRef.current = true;
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, content } : m)));
  }, []);

  /** 删除消息（生成完全失败时移除空占位） */
  const removeMessage = useCallback((id: string) => {
    dirtyRef.current = true;
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  /** 清空当前文件的会话 */
  const clearChat = useCallback(() => {
    dirtyRef.current = true;
    setMessages([]);
  }, []);

  return { messages, appendMessage, updateMessage, removeMessage, clearChat };
}
