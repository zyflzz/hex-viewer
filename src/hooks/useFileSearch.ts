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
 * 进度通过 search://progress 事件流式回传，可随时取消。
 */
export function useFileSearch(fileMeta: FileMeta | null) {
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
      setState(s => (s.running ? { ...s, progress: e.payload } : s));
    });
    return () => {
      un.then(f => f());
    };
  }, []);

  const runSearch = useCallback(
    async (mode: SearchMode, pattern: string, caseSensitive: boolean) => {
      if (!fileMeta || !pattern.trim()) return;
      const token = ++tokenRef.current;
      setState({
        running: true,
        progress: { searched: 0, total: fileMeta.size, hits: 0 },
        results: [],
        error: null,
        finishedAt: 0,
        truncated: false,
      });
      try {
        const results = await invoke<SearchHit[]>('search', {
          mode,
          pattern,
          caseSensitive,
          maxResults: 10000,
        });
        if (tokenRef.current !== token) return; // 已被新搜索 / 新文件取代
        setState({
          running: false,
          progress: null,
          results,
          error: null,
          finishedAt: Date.now(),
          truncated: results.length >= 10000,
        });
      } catch (err) {
        if (tokenRef.current !== token) return;
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
      }
    },
    [fileMeta],
  );

  const cancelSearch = useCallback(() => {
    tokenRef.current += 1;
    invoke('cancel_search').catch(() => {});
    setState(s => ({ ...s, running: false, progress: null }));
  }, []);

  const clearSearch = useCallback(() => {
    tokenRef.current += 1;
    invoke('cancel_search').catch(() => {});
    setState({
      running: false,
      progress: null,
      results: [],
      error: null,
      finishedAt: 0,
      truncated: false,
    });
  }, []);

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
