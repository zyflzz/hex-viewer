import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileMeta } from '../types';

/** 分片大小：64KB，是 8/16/32（行字节数）的公倍数，保证行永不跨片 */
export const CHUNK_SIZE = 64 * 1024;
/** 缓存分片数上限（约 640KB，内存占用恒定） */
const MAX_CACHED_CHUNKS = 10;
/** 预取防抖（毫秒） */
const PREFETCH_DELAY = 100;

function toBytes(res: unknown): Uint8Array {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (Array.isArray(res)) return new Uint8Array(res);
  throw new Error('分片数据格式异常');
}

/**
 * 文件分片加载：
 * - 打开文件只取元数据（mmap 建立在 Rust 侧，不读内容）
 * - 滚动时按需拉取可见区域对应的 64KB 分片，并预取邻接分片
 * - LRU 式淘汰，内存占用与文件大小无关
 */
export function useFileWindow() {
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [loading, setLoading] = useState(false);

  const chunksRef = useRef<Map<number, Uint8Array>>(new Map());
  const pendingRef = useRef<Set<number>>(new Set());
  const tokenRef = useRef(0);
  const prefetchTimerRef = useRef<number | null>(null);
  const viewCenterChunkRef = useRef(0);
  // fileMeta 的同步镜像，避免 fetchChunk 依赖 state 导致闭包过期
  const fileMetaRef = useRef<FileMeta | null>(null);

  const bumpCache = useCallback(() => {
    setCacheVersion(v => v + 1);
    setCacheBytes(
      Array.from(chunksRef.current.values()).reduce((s, c) => s + c.length, 0),
    );
  }, []);

  const evictFarChunks = useCallback((centerChunk: number) => {
    const map = chunksRef.current;
    if (map.size <= MAX_CACHED_CHUNKS) return;
    const keys = Array.from(map.keys()).sort(
      (a, b) => Math.abs(b - centerChunk) - Math.abs(a - centerChunk),
    );
    let removed = false;
    while (map.size > MAX_CACHED_CHUNKS && keys.length) {
      map.delete(keys.shift()!);
      removed = true;
    }
    if (removed) bumpCache();
  }, [bumpCache]);

  const fetchChunk = useCallback(
    (chunkOffset: number, token: number) => {
      const map = chunksRef.current;
      const pending = pendingRef.current;
      if (map.has(chunkOffset) || pending.has(chunkOffset)) return;
      const size = fileMetaRef.current?.size ?? 0;
      if (chunkOffset >= size) return;
      pending.add(chunkOffset);
      setLoading(true);
      const length = Math.min(CHUNK_SIZE, size - chunkOffset);
      invoke('read_chunk', { offset: chunkOffset, length })
        .then(res => {
          if (tokenRef.current !== token) return; // 已切换文件，丢弃
          pending.delete(chunkOffset);
          map.set(chunkOffset, toBytes(res));
          bumpCache();
        })
        .catch(err => {
          if (tokenRef.current !== token) return;
          pending.delete(chunkOffset);
          console.error('读取分片失败:', err);
        })
        .finally(() => {
          if (tokenRef.current !== token) return;
          if (pendingRef.current.size === 0) setLoading(false);
        });
    },
    [bumpCache],
  );

  // fileMeta 的同步镜像见顶部声明

  const openFile = useCallback(async (path: string): Promise<FileMeta> => {
    const meta = await invoke<FileMeta>('open_file', { path });
    // 重置全部窗口状态（含在途请求的 loading 标记）
    tokenRef.current += 1;
    chunksRef.current.clear();
    pendingRef.current.clear();
    fileMetaRef.current = meta;
    setFileMeta(meta);
    setCacheBytes(0);
    setCacheVersion(v => v + 1);
    setLoading(false);
    // 预载开头两个分片
    const token = tokenRef.current;
    fetchChunk(0, token);
    if (meta.size > CHUNK_SIZE) fetchChunk(CHUNK_SIZE, token);
    return meta;
  }, [fetchChunk]);

  /**
   * 保证 [startByte, endByte] 覆盖的分片在缓存中（可见区立即加载，邻接区延迟预取）
   */
  const ensureRange = useCallback(
    (startByte: number, endByte: number) => {
      const size = fileMetaRef.current?.size ?? 0;
      if (size <= 0 || endByte < startByte) return;
      const token = tokenRef.current;
      const firstChunk = Math.floor(startByte / CHUNK_SIZE);
      const lastChunk = Math.floor(Math.min(endByte, size - 1) / CHUNK_SIZE);
      viewCenterChunkRef.current = Math.floor((firstChunk + lastChunk) / 2);

      // 可见区分片：立即加载
      for (let c = firstChunk; c <= lastChunk; c++) {
        fetchChunk(c * CHUNK_SIZE, token);
      }

      // 邻接预取：防抖，避免快速拖动滚动条时的无效 IO
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
      }
      prefetchTimerRef.current = window.setTimeout(() => {
        prefetchTimerRef.current = null;
        if (tokenRef.current !== token) return;
        const cur = tokenRef.current;
        const center = viewCenterChunkRef.current;
        for (const c of [center - 2, center - 1, center + 1, center + 2]) {
          if (c >= 0 && c * CHUNK_SIZE < size) {
            fetchChunk(c * CHUNK_SIZE, cur);
          }
        }
        evictFarChunks(center);
      }, PREFETCH_DELAY);
    },
    [fetchChunk, evictFarChunks],
  );

  /**
   * 提取一行字节；行不跨分片（行字节数整除 64KB），一次 Map 查找即可。
   * 未命中返回 null（渲染占位行）。
   */
  const getBytes = useCallback(
    (offset: number, len: number): Uint8Array | null => {
      const map = chunksRef.current;
      const chunkOffset = Math.floor(offset / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = map.get(chunkOffset);
      if (!chunk) return null;
      const local = offset - chunkOffset;
      const end = Math.min(local + len, chunk.length);
      if (local >= chunk.length) return null;
      return chunk.subarray(local, end);
    },
    [],
  );

  /**
   * 读取任意字节范围（用于复制）：缺的分片同步补拉后拼装
   */
  const readRange = useCallback(async (offset: number, len: number): Promise<Uint8Array> => {
    const size = fileMetaRef.current?.size ?? 0;
    const end = Math.min(offset + len, size);
    if (offset >= end) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);
    const tasks: Promise<void>[] = [];
    const token = tokenRef.current;
    let c = Math.floor(offset / CHUNK_SIZE);
    const lastC = Math.floor((end - 1) / CHUNK_SIZE);
    for (; c <= lastC; c++) {
      const chunkOffset = c * CHUNK_SIZE;
      const chunk = chunksRef.current.get(chunkOffset);
      if (chunk) {
        const from = Math.max(offset, chunkOffset) - chunkOffset;
        const to = Math.min(end, chunkOffset + chunk.length) - chunkOffset;
        out.set(chunk.subarray(from, to), Math.max(offset, chunkOffset) - offset);
      } else {
        const length = Math.min(CHUNK_SIZE, size - chunkOffset);
        tasks.push(
          invoke('read_chunk', { offset: chunkOffset, length })
            .then(res => {
              const data = toBytes(res);
              chunksRef.current.set(chunkOffset, data);
              const from = Math.max(offset, chunkOffset) - chunkOffset;
              const to = Math.min(end, chunkOffset + data.length) - chunkOffset;
              out.set(data.subarray(from, to), Math.max(offset, chunkOffset) - offset);
            })
            .catch(err => {
              console.error('读取分片失败:', err);
              throw err;
            }),
        );
      }
    }
    await Promise.all(tasks);
    if (token !== tokenRef.current) throw new Error('文件已切换');
    return out;
  }, []);

  const closeFile = useCallback(() => {
    tokenRef.current += 1;
    chunksRef.current.clear();
    pendingRef.current.clear();
    fileMetaRef.current = null;
    setFileMeta(null);
    setCacheBytes(0);
    setLoading(false);
  }, []);

  // 卸载时清理预取计时器
  useEffect(
    () => () => {
      if (prefetchTimerRef.current !== null) window.clearTimeout(prefetchTimerRef.current);
    },
    [],
  );

  return {
    fileMeta,
    cacheVersion,
    cacheBytes,
    loading,
    openFile,
    closeFile,
    ensureRange,
    getBytes,
    readRange,
  };
}
