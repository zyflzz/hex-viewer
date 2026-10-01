import type { FileMeta, Selection, TextEncoding } from '../types';
import { formatBytes, hexOffset, offsetDigits } from '../utils/format';
import { encodingLabel } from '../utils/decode';

interface StatusBarProps {
  meta: FileMeta | null;
  hoverOffset: number | null;
  selection: Selection | null;
  rowBytes: number;
  encoding: TextEncoding;
  loading: boolean;
  toast: string | null;
  onCopyHex: () => void;
  onCopyAscii: () => void;
}

export function StatusBar({
  meta,
  hoverOffset,
  selection,
  rowBytes,
  encoding,
  loading,
  toast,
  onCopyHex,
  onCopyAscii,
}: StatusBarProps) {
  const digits = meta ? offsetDigits(meta.size) : 8;
  const selCount = selection ? selection.end - selection.start + 1 : 0;

  return (
    <footer className="statusbar">
      <span className="status-item">
        偏移 <span className="mono">{hoverOffset !== null ? hexOffset(hoverOffset, digits) : '—'}</span>
      </span>
      {selection && (
        <span className="status-item">
          选择{' '}
          <span className="mono">
            {hexOffset(selection.start, digits)}–{hexOffset(selection.end, digits)}
          </span>{' '}
          ({selCount} B)
          <button className="btn mini" onClick={onCopyHex} title="复制选中字节的十六进制">
            复制 Hex
          </button>
          <button className="btn mini" onClick={onCopyAscii} title="复制选中字节的 ASCII 文本">
            复制 ASCII
          </button>
        </span>
      )}
      {meta && (
        <span className="status-item">
          编码 <span className="mono">{encodingLabel(encoding)}</span>
        </span>
      )}
      {meta && (
        <span className="status-item">
          每行 {rowBytes} B · 共 {formatBytes(meta.size)}
        </span>
      )}
      {loading && (
        <span className="status-item status-loading">
          <span className="spin" />
          加载分片…
        </span>
      )}
      <span className="status-flex" />
      {toast && <span className="status-toast">{toast}</span>}
    </footer>
  );
}
