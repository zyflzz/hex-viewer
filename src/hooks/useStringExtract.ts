import { invoke } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';
import type { FileMeta, StringEncoding, StringHit } from '../types';

export interface StringExtractState {
  hits: StringHit[];
  /** 命中总数（可能多于 hits.length） */
  total: number;
  running: boolean;
  error: string | null;
  refresh: (minLength: number, encodings: StringEncoding[]) => void;
}

/**
 * 全文件字符串提取（分析选项卡）。
 * 扫描在 Rust 侧完成（mmap 流式），重新调用 refresh 会自动作废上一次扫描
 * （Rust 侧按代数取消），通过序号保证只有最新请求的结果会落地。
 */
export function useStringExtract(tabId: string, meta: FileMeta | null): StringExtractState {
  const [hits, setHits] = useState<StringHit[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const refresh = useCallback(
    (minLength: number, encodings: StringEncoding[]) => {
      if (!meta || meta.size === 0) return;
      if (encodings.length === 0) {
        setError('请至少选择一种编码');
        return;
      }
      const seq = ++seqRef.current;
      setRunning(true);
      setError(null);
      invoke<{ hits: StringHit[]; total: number }>('extract_strings', {
        tabId,
        minLength,
        encodings,
      })
        .then(r => {
          if (seqRef.current !== seq) return; // 已被更新的扫描取代
          setHits(r.hits);
          setTotal(r.total);
          setRunning(false);
        })
        .catch(e => {
          if (seqRef.current !== seq) return; // 被"取消"的旧扫描，忽略
          setError(String(e));
          setRunning(false);
        });
    },
    [tabId, meta],
  );

  return { hits, total, running, error, refresh };
}
