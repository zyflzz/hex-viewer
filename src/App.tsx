import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { HexViewer } from './components/HexViewer';
import './App.css';

interface FileInfo {
  name: string;
  size: number;
  bytes: Uint8Array;
  path: string;
}

function App() {
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleOpenFile = async () => {
    try {
      // 1. 调用系统原生文件选择对话框
      const selectedPath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Binary Files', extensions: ['bin', 'hex', 'dat', ''] }]
      });

      if (!selectedPath) return; // 用户取消了选择

      const path = selectedPath as string;

      // 2. 通过 invoke 调用 Rust 后端命令
      const bytes = await invoke<number[]>('read_file', { path });

      // 3. 更新前端状态
      setFileInfo({
        name: path.split(/[/\\]/).pop() || 'unknown',
        size: bytes.length,
        bytes: new Uint8Array(bytes),
        path,
      });
      setError(null);
    } catch (err) {
      setError(`读取文件失败: ${err}`);
      console.error(err);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <button onClick={handleOpenFile}>打开文件</button>
        {error && <span className="error-message">{error}</span>}
      </header>

      <div className="main-content">
        <main className="hex-display">
          {fileInfo ? (
            <HexViewer bytes={fileInfo.bytes} />
          ) : (
            <div className="empty-state">请打开一个文件以查看内容</div>
          )}
        </main>

        <aside className="sidebar">
          <h3>文件信息</h3>
          {fileInfo ? (
            <ul className="file-info-list">
              <li><strong>名称：</strong> {fileInfo.name}</li>
              <li>
                <strong>大小：</strong> {fileInfo.size} 字节 (
                {(fileInfo.size / 1024).toFixed(2)} KB)
              </li>
              <li>
                <strong>路径：</strong> <code>{fileInfo.path}</code>
              </li>
            </ul>
          ) : (
            <p className="placeholder-text">暂无文件信息</p>
          )}
        </aside>
      </div>
    </div>
  );
}

export default App;