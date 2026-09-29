import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PerfInfo } from '../types';

const SAMPLES = 60; // 保留最近 60 个采样点（1Hz → 1 分钟）

export interface PerfState {
  current: PerfInfo | null;
  memoryHistory: number[]; // MB
  cpuHistory: number[]; // %
}

/** 1Hz 轮询进程内存 / CPU 占用，保留历史用于迷你趋势图 */
export function usePerfMonitor(enabled: boolean): PerfState {
  const [state, setState] = useState<PerfState>({
    current: null,
    memoryHistory: [],
    cpuHistory: [],
  });

  useEffect(() => {
    if (!enabled) {
      setState({ current: null, memoryHistory: [], cpuHistory: [] });
      return;
    }
    let alive = true;
    const tick = () => {
      invoke<PerfInfo>('get_perf')
        .then(p => {
          if (!alive) return;
          setState(prev => ({
            current: p,
            memoryHistory: [...prev.memoryHistory, p.memory / 1024 / 1024].slice(-SAMPLES),
            cpuHistory: [...prev.cpuHistory, p.cpu].slice(-SAMPLES),
          }));
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return state;
}
