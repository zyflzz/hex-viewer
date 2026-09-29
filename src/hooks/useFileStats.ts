import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AnalysisProgress, FileMeta, FileStats } from '../types';

export interface StatsState {
  running: boolean;
  progress: number; // 0..1
  stats: FileStats | null;
}

/**
 * 后台全文件统计分析（可打印字符数 / 零字节 / 高位字节等），
 * 大文件扫描通过 analysis://progress 事件回报进度，不阻塞界面。
 */
export function useFileStats(fileMeta: FileMeta | null) {
  const [state, setState] = useState<StatsState>({ running: false, progress: 0, stats: null });
  const tokenRef = useRef(0);

  useEffect(() => {
    const un = listen<AnalysisProgress>('analysis://progress', e => {
      const { searched, total } = e.payload;
      setState(s =>
        s.running ? { ...s, progress: total > 0 ? searched / total : 1 } : s,
      );
    });
    return () => {
      un.then(f => f());
    };
  }, []);

  useEffect(() => {
    if (!fileMeta || fileMeta.size === 0) {
      setState({ running: false, progress: 0, stats: fileMeta ? { total: 0, printable: 0, control: 0, high: 0, zero: 0, line_breaks: 0 } : null });
      return;
    }
    const token = ++tokenRef.current;
    setState({ running: true, progress: 0, stats: null });
    invoke<FileStats>('analyze_file')
      .then(stats => {
        if (tokenRef.current !== token) return;
        setState({ running: false, progress: 1, stats });
      })
      .catch(err => {
        if (tokenRef.current !== token) return;
        // 打开新文件会取消旧统计，静默忽略
        if (!String(err).includes('已取消')) {
          console.error('统计分析失败:', err);
        }
        setState(s => ({ ...s, running: false }));
      });
  }, [fileMeta?.path, fileMeta?.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const reanalyze = useCallback(() => {
    if (!fileMeta) return;
    const token = ++tokenRef.current;
    setState({ running: true, progress: 0, stats: null });
    invoke<FileStats>('analyze_file')
      .then(stats => {
        if (tokenRef.current !== token) return;
        setState({ running: false, progress: 1, stats });
      })
      .catch(() => setState(s => ({ ...s, running: false })));
  }, [fileMeta]);

  return { ...state, reanalyze };
}
