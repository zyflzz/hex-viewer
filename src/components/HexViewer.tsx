import React from 'react';

const ROW_BYTES = 16; // 每行显示16个字节

interface HexViewerProps {
  bytes: Uint8Array;
}

export const HexViewer: React.FC<HexViewerProps> = ({ bytes }) => {
  const rows: React.ReactNode[] = [];

  for (let i = 0; i < bytes.length; i += ROW_BYTES) {
    const chunk = bytes.subarray(i, Math.min(i + ROW_BYTES, bytes.length));

    // 偏移地址
    const offset = i.toString(16).padStart(8, '0').toUpperCase();

    // Hex 部分
    const hex = Array.from(chunk)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');

    // ASCII 部分
    const ascii = Array.from(chunk)
      .map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');

    rows.push(
      <div key={i} className="hex-row">
        <span className="hex-offset">{offset}</span>
        <span className="hex-bytes">{hex}</span>
        <span className="hex-ascii">{ascii}</span>
      </div>
    );
  }

  return <div className="hex-viewer">{rows}</div>;
};