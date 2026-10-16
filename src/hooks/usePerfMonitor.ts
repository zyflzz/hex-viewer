import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PerfInfo } from '../types';

const SAMPLES = 60; // 保留最近 60 个采样点（1Hz → 1 分钟）

export interface PerfState {
  current: PerfInfo | null;
  memoryHistory: number[]; // MB
  cpuHistory: number[]; // %
}

/**
 * 模块级性能采样 store（useSyncExternalStore 单例）：
 * 多标签页架构下每个 FileTab 的侧栏都会展示性能监控，
 * 若各自 useState 轮询会导致隐藏标签页每秒无谓重渲染、且产生 N 个轮询循环。
 * 这里全局只跑一个 1Hz 轮询（首个订阅者启动，最后一个取消时停止），
 * 所有订阅组件共享同一快照。隐藏标签页通过条件渲染不订阅（见 Sidebar perfEnabled）。
 */

let state: PerfState = { current: null, memoryHistory: [], cpuHistory: [] };
const listeners = new Set<() => void>();
let timer: number | null = null;

function emit() {
  for (const l of listeners) l();
}

function tick() {
  invoke<PerfInfo>('get_perf')
    .then(p => {
      state = {
        current: p,
        memoryHistory: [...state.memoryHistory, p.memory / 1024 / 1024].slice(-SAMPLES),
        cpuHistory: [...state.cpuHistory, p.cpu].slice(-SAMPLES),
      };
      emit();
    })
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    tick();
    timer = window.setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): PerfState {
  return state;
}

/** 订阅全局性能采样（1Hz，进程级内存 / CPU + 历史趋势） */
export function usePerf(): PerfState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
