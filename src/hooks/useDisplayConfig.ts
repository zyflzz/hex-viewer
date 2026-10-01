import { useCallback, useEffect, useState } from 'react';
import type { BytesPerRow, DisplayConfig, TextEncoding, ThemeName } from '../types';
import { ENCODING_VALUES } from '../utils/decode';

const STORAGE_KEY = 'hex-viewer-config-v1';

const DEFAULT_CONFIG: DisplayConfig = {
  bytesPerRow: 16,
  fontSize: 14,
  theme: 'dark',
  showAscii: true,
  encoding: 'ascii',
};

function loadConfig(): DisplayConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<DisplayConfig>;
    return {
      bytesPerRow: ([8, 16, 32] as BytesPerRow[]).includes(parsed.bytesPerRow as BytesPerRow)
        ? (parsed.bytesPerRow as BytesPerRow)
        : DEFAULT_CONFIG.bytesPerRow,
      fontSize:
        typeof parsed.fontSize === 'number' && parsed.fontSize >= 10 && parsed.fontSize <= 24
          ? Math.round(parsed.fontSize)
          : DEFAULT_CONFIG.fontSize,
      theme: (['dark', 'light', 'contrast'] as ThemeName[]).includes(parsed.theme as ThemeName)
        ? (parsed.theme as ThemeName)
        : DEFAULT_CONFIG.theme,
      showAscii: typeof parsed.showAscii === 'boolean' ? parsed.showAscii : DEFAULT_CONFIG.showAscii,
      encoding: ENCODING_VALUES.includes(parsed.encoding as TextEncoding)
        ? (parsed.encoding as TextEncoding)
        : DEFAULT_CONFIG.encoding,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 显示配置（行字节数 / 字体 / 主题 / ASCII 列），持久化到 localStorage */
export function useDisplayConfig() {
  const [config, setConfig] = useState<DisplayConfig>(loadConfig);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* 忽略持久化失败 */
    }
  }, [config]);

  const setBytesPerRow = useCallback((bytesPerRow: BytesPerRow) => {
    setConfig(c => ({ ...c, bytesPerRow }));
  }, []);

  const setFontSize = useCallback((fontSize: number) => {
    setConfig(c => ({ ...c, fontSize: Math.min(24, Math.max(10, Math.round(fontSize))) }));
  }, []);

  const zoomFont = useCallback((delta: number) => {
    setConfig(c => ({
      ...c,
      fontSize: Math.min(24, Math.max(10, c.fontSize + delta)),
    }));
  }, []);

  const setTheme = useCallback((theme: ThemeName) => {
    setConfig(c => ({ ...c, theme }));
  }, []);

  const toggleAscii = useCallback(() => {
    setConfig(c => ({ ...c, showAscii: !c.showAscii }));
  }, []);

  const setEncoding = useCallback((encoding: TextEncoding) => {
    setConfig(c => ({ ...c, encoding }));
  }, []);

  return { config, setBytesPerRow, setFontSize, zoomFont, setTheme, toggleAscii, setEncoding };
}
