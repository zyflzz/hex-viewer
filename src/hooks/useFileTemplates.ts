import { useCallback, useEffect, useState } from 'react';
import type { FileTemplate, TemplateField } from '../types';

/**
 * 结构模板管理（v1.1.5）：按文件路径持久化到 localStorage。
 * 与对话/书签隔离的独立存储键；同一路径保存多个模板，加载时整组替换应用字段。
 */
const STORAGE_KEY = 'hex-viewer-templates-v1';
/** 最多为多少个文件保留模板 */
const MAX_FILES = 32;
/** 单文件模板数上限 */
const MAX_TEMPLATES = 16;

type TemplateStore = Record<string, FileTemplate[]>;

function isTemplate(v: unknown): v is FileTemplate {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<FileTemplate>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.createdAt === 'number' &&
    Array.isArray(t.fields)
  );
}

function loadStore(): TemplateStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const store: TemplateStore = {};
    for (const [path, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) {
        const valid = list.filter(isTemplate).slice(-MAX_TEMPLATES);
        if (valid.length) store[path] = valid;
      }
    }
    return store;
  } catch {
    return {};
  }
}

function saveStore(store: TemplateStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 配额不足：淘汰最旧的文件后重试一次
    const paths = Object.keys(store);
    if (paths.length > 1) {
      paths
        .sort(
          (a, b) =>
            (store[a][store[a].length - 1]?.createdAt ?? 0) -
            (store[b][store[b].length - 1]?.createdAt ?? 0),
        )
        .slice(0, paths.length - 1)
        .forEach(p => delete store[p]);
      saveStore(store);
    }
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useFileTemplates(path: string | null) {
  const [templates, setTemplates] = useState<FileTemplate[]>([]);

  useEffect(() => {
    setTemplates(path ? loadStore()[path] ?? [] : []);
  }, [path]);

  /** 保存（或按 id 覆盖）一份模板 */
  const saveTemplate = useCallback(
    (name: string, fields: TemplateField[], id?: string): FileTemplate => {
      const tpl: FileTemplate = {
        id: id ?? newId(),
        name: name.trim() || '未命名模板',
        createdAt: Date.now(),
        fields,
      };
      setTemplates(prev => {
        const next = id ? prev.map(t => (t.id === id ? tpl : t)) : [...prev, tpl].slice(-MAX_TEMPLATES);
        if (path) {
          const store = loadStore();
          store[path] = next;
          // 淘汰其他最久未更新的文件
          const others = Object.keys(store).filter(k => k !== path);
          if (others.length >= MAX_FILES) {
            others
              .sort(
                (a, b) =>
                  (store[a][store[a].length - 1]?.createdAt ?? 0) -
                  (store[b][store[b].length - 1]?.createdAt ?? 0),
              )
              .slice(0, others.length - MAX_FILES + 1)
              .forEach(k => delete store[k]);
          }
          saveStore(store);
        }
        return next;
      });
      return tpl;
    },
    [path],
  );

  const deleteTemplate = useCallback(
    (id: string) => {
      setTemplates(prev => {
        const next = prev.filter(t => t.id !== id);
        if (path) {
          const store = loadStore();
          if (next.length) store[path] = next;
          else delete store[path];
          saveStore(store);
        }
        return next;
      });
    },
    [path],
  );

  return { templates, saveTemplate, deleteTemplate };
}
