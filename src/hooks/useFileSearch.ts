import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FileMeta, SearchHit, SearchProgress } from '../types';

export type SearchMode = 'text' | 'hex';

export interface SearchState {
  running: boolean;
  progress: SearchProgress | null;
  results: SearchHit[];
  error: string | null;
  /** 本次搜索完成的时刻（用于提示） */
  finishedAt: number;
  truncated: boolean;
}

/**
 * 全文件搜索：Rust 侧 mmap + memchr 扫描，
 * 进度通过 search://progress 事件流式回传（按 tabId 过滤），可随时取消。
 */
export function useFileSearch(tabId: string, fileMeta: FileMeta | null) {
  const [state, setState] = useState<SearchState>({
    running: false,
    progress: null,
    results: [],
    error: null,
    finishedAt: 0,
    truncated: false,
  });
  const tokenRef = useRef(0);

  useEffect(() => {
    const un = listen<SearchProgress>('search://progress', e => {
      if (e.payload.tabId !== tabId) return; // 其他标签页的搜索进度
      setState(s => (s.running ? { ...s, progress: e.payload } : s));
    });
    return () => {
      un.then(f => f());
    };
  }, [tabId]);

  const runSearch = useCallback(
    async (mode: SearchMode, pattern: string, caseSensitive: boolean): Promise<SearchHit[]> => {
      if (!fileMeta || !pattern.trim()) return [];
      const token = ++tokenRef.current;
      setState({
        running: true,
        progress: { tabId, searched: 0, total: fileMeta.size, hits: 0 },
        results: [],
        error: null,
        finishedAt: 0,
        truncated: false,
      });
      try {
        const results = await invoke<SearchHit[]>('search', {
          tabId,
          mode,
          pattern,
          caseSensitive,
          maxResults: 10000,
        });
        if (tokenRef.current !== token) return []; // 已被新搜索 / 新文件取代
        setState({
          running: false,
          progress: null,
          results,
          error: null,
          finishedAt: Date.now(),
          truncated: results.length >= 10000,
        });
        return results;
      } catch (err) {
        if (tokenRef.current !== token) return [];
        const msg = String(err);
        if (msg.includes('已取消')) {
          setState(s => ({ ...s, running: false, progress: null }));
        } else {
          setState({
            running: false,
            progress: null,
            results: [],
            error: msg,
            finishedAt: Date.now(),
            truncated: false,
          });
        }
        return [];
      }
    },
    [fileMeta, tabId],
  );

  const cancelSearch = useCallback(() => {
    tokenRef.current += 1;
    invoke('cancel_search', { tabId }).catch(() => {});
    setState(s => ({ ...s, running: false, progress: null }));
  }, [tabId]);

  const clearSearch = useCallback(() => {
    tokenRef.current += 1;
    invoke('cancel_search', { tabId }).catch(() => {});
    setState({
      running: false,
      progress: null,
      results: [],
      error: null,
      finishedAt: 0,
      truncated: false,
    });
  }, [tabId]);

  // 切换文件时清空结果
  useEffect(() => {
    tokenRef.current += 1;
    setState({
      running: false,
      progress: null,
      results: [],
      error: null,
      finishedAt: 0,
      truncated: false,
    });
  }, [fileMeta?.path, fileMeta?.size]);

  return { ...state, runSearch, cancelSearch, clearSearch };
}
