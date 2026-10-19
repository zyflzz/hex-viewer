// 可变长度编辑模型（v1.1.4）：
// - 基线 = 打开（或保存后重建）的 mmap，所有 piece 要么指向基线的一段区间，要么指向追加缓冲区
// - 追加缓冲区只增长不收缩，所有插入内容连续存放
// - 虚拟文件 = 依次拼接所有 piece；虚拟偏移是界面上唯一可见的偏移语义
// - 插入/删除通过切分 piece 完成；每次结构变更后重建前缀和（starts）供二分定位
// - 保存时按 piece 表顺序输出，并把前端覆盖层（等长替换）按虚拟偏移打补丁
use std::collections::BTreeMap;
use std::io::Write;

/// 单个 piece：指向基线（mmap）或追加缓冲区的一段连续区间
#[derive(Clone, Copy, Debug)]
pub struct Piece {
    /// true = 追加缓冲区；false = 基线
    pub from_append: bool,
    /// 起始位置（基线偏移或追加缓冲区偏移）
    pub start: u64,
    pub len: u64,
}

/// piece 表：内存中的可变长度编辑状态
#[derive(Debug)]
pub struct PieceTable {
    pieces: Vec<Piece>,
    append_buf: Vec<u8>,
    /// starts[i] = pieces[i] 的虚拟起始偏移；starts[len] = 虚拟大小
    starts: Vec<u64>,
}

impl PieceTable {
    /// 全新状态：单个基线 piece 覆盖 [0, base_len)
    pub fn new(base_len: u64) -> Self {
        let pieces = if base_len > 0 {
            vec![Piece { from_append: false, start: 0, len: base_len }]
        } else {
            Vec::new()
        };
        let mut pt = PieceTable { pieces, append_buf: Vec::new(), starts: Vec::new() };
        pt.rebuild();
        pt
    }

    /// 从已有部件重建（保存时在阻塞线程内使用快照数据）
    pub fn from_parts(pieces: Vec<Piece>, append_buf: Vec<u8>) -> Self {
        let mut pt = PieceTable { pieces, append_buf, starts: Vec::new() };
        pt.rebuild();
        pt
    }

    pub fn virtual_size(&self) -> u64 {
        *self.starts.last().unwrap_or(&0)
    }

    pub fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    pub fn append_buf(&self) -> &[u8] {
        &self.append_buf
    }

    fn rebuild(&mut self) {
        self.starts.clear();
        self.starts.reserve(self.pieces.len() + 1);
        let mut acc: u64 = 0;
        self.starts.push(0);
        for p in &self.pieces {
            acc += p.len;
            self.starts.push(acc);
        }
    }

    /// 二分查找包含虚拟偏移 off 的 piece，返回 (下标, piece 内偏移)
    fn locate(&self, off: u64) -> Option<(usize, u64)> {
        if self.pieces.is_empty() || off >= self.virtual_size() {
            return None;
        }
        // starts[i] <= off < starts[i+1]
        let i = self.starts.partition_point(|&s| s <= off) - 1;
        Some((i, off - self.starts[i]))
    }

    /// 在虚拟偏移 off 处切分：返回起始偏移恰为 off 的 piece 下标。
    /// off == 虚拟大小或空表时返回 pieces.len()。
    fn split_at(&mut self, off: u64) -> usize {
        if off >= self.virtual_size() || self.pieces.is_empty() {
            return self.pieces.len();
        }
        if let Some((i, local)) = self.locate(off) {
            if local == 0 {
                return i; // 已在边界
            }
            let p = self.pieces[i];
            self.pieces[i] = Piece { from_append: p.from_append, start: p.start, len: local };
            self.pieces.insert(
                i + 1,
                Piece { from_append: p.from_append, start: p.start + local, len: p.len - local },
            );
            self.rebuild();
            i + 1
        } else {
            self.pieces.len()
        }
    }

    /// 在虚拟偏移 off 处插入 bytes（off 允许 == 虚拟大小 = 追加到末尾）
    pub fn insert(&mut self, off: u64, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let start = self.append_buf.len() as u64;
        self.append_buf.extend_from_slice(bytes);
        let idx = self.split_at(off);
        self.pieces.insert(
            idx,
            Piece { from_append: true, start, len: bytes.len() as u64 },
        );
        self.rebuild();
    }

    /// 删除虚拟区间 [off, off+len)
    pub fn delete(&mut self, off: u64, len: u64) {
        let vsize = self.virtual_size();
        if len == 0 || off >= vsize {
            return;
        }
        let end = (off + len).min(vsize);
        let i = self.split_at(off);
        let j = self.split_at(end);
        self.pieces.drain(i..j);
        self.rebuild();
    }

    /// 读取虚拟区间 [off, off+max_len) 的内容（跨 piece 拼接），实际长度由调用者裁剪
    pub fn read(&self, off: u64, max_len: u64, base: &[u8]) -> Vec<u8> {
        let vsize = self.virtual_size();
        if off >= vsize || max_len == 0 {
            return Vec::new();
        }
        let end = (off + max_len).min(vsize);
        let mut out = Vec::with_capacity((end - off) as usize);
        let mut pos = off;
        while pos < end {
            let (i, local) = match self.locate(pos) {
                Some(x) => x,
                None => break,
            };
            let p = self.pieces[i];
            let take = ((p.len - local).min(end - pos)) as usize;
            let src_start = (p.start + local) as usize;
            if p.from_append {
                let s = src_start.min(self.append_buf.len());
                let e = (src_start + take).min(self.append_buf.len());
                out.extend_from_slice(&self.append_buf[s..e]);
            } else if let Some(s) = base.get(src_start..src_start + take) {
                out.extend_from_slice(s);
            }
            pos += take as u64;
        }
        out
    }

    /// 把整个虚拟内容写入 out，同时应用 patch（虚拟偏移 → 字节）。
    /// patch 必须按偏移升序传入（BTreeMap 天然有序）。
    pub fn write_patched<W: Write>(
        &self,
        out: &mut W,
        base: &[u8],
        patch: &BTreeMap<u64, u8>,
    ) -> std::io::Result<u64> {
        let mut patch_iter: Vec<(u64, u8)> = patch.iter().map(|(&k, &v)| (k, v)).collect();
        patch_iter.sort_unstable();
        let mut pi = 0usize; // 下一个待应用补丁的下标
        let mut written: u64 = 0; // 已写出的虚拟偏移
        for p in &self.pieces {
            let mut local: u64 = 0;
            let src_start = p.start as usize;
            while local < p.len {
                // 跳过已过期的补丁（不应出现，防御）
                while pi < patch_iter.len() && patch_iter[pi].0 < written {
                    pi += 1;
                }
                let (chunk, is_patched) = if pi < patch_iter.len() && patch_iter[pi].0 == written {
                    (1usize, true)
                } else {
                    let gap = if pi < patch_iter.len() {
                        (patch_iter[pi].0 - written).min(p.len - local)
                    } else {
                        p.len - local
                    };
                    (gap.max(1) as usize, false)
                };
                if is_patched {
                    out.write_all(&[patch_iter[pi].1])?;
                    pi += 1;
                } else {
                    let s = src_start + local as usize;
                    let e = s + chunk;
                    if p.from_append {
                        let s = s.min(self.append_buf.len());
                        let e = e.min(self.append_buf.len());
                        out.write_all(&self.append_buf[s..e])?;
                    } else if let Some(slice) = base.get(s..e) {
                        out.write_all(slice)?;
                    }
                }
                local += chunk as u64;
                written += chunk as u64;
            }
        }
        Ok(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(base: &[u8]) -> PieceTable {
        PieceTable::new(base.len() as u64)
    }

    #[test]
    fn insert_read_delete() {
        let base = b"HELLO WORLD";
        let mut t = pt(base);
        t.insert(5, b" BRAVE".as_slice());
        assert_eq!(t.read(0, 100, base), b"HELLO BRAVE WORLD");
        t.delete(5, 6);
        assert_eq!(t.read(0, 100, base), b"HELLO WORLD");
        t.delete(0, 6);
        assert_eq!(t.read(0, 100, base), b"WORLD");
        t.insert(5, b"!".as_slice());
        assert_eq!(t.read(0, 100, base), b"WORLD!");
    }

    #[test]
    fn insert_at_boundaries() {
        let base = b"AB";
        let mut t = pt(base);
        t.insert(0, b"0".as_slice());
        t.insert(3, b"3".as_slice());
        t.insert(2, b"2".as_slice());
        assert_eq!(t.read(0, 100, base), b"0A2B3");
    }

    #[test]
    fn write_patched_basic() {
        let base = b"HELLO WORLD";
        let mut t = pt(base);
        t.insert(5, b" BRAVE".as_slice());
        let mut patch = BTreeMap::new();
        patch.insert(0u64, b'J' as u8);
        patch.insert(16u64, b'?' as u8); // 虚拟 16 = 'D'
        let mut out = Vec::new();
        t.write_patched(&mut out, base, &patch).unwrap();
        assert_eq!(out, b"JELLO BRAVE WORL?");
    }

    #[test]
    fn empty_base() {
        let mut t = pt(b"");
        assert_eq!(t.virtual_size(), 0);
        t.insert(0, b"XY".as_slice());
        assert_eq!(t.read(0, 10, b""), b"XY");
        t.insert(1, b"Z".as_slice());
        assert_eq!(t.read(0, 10, b""), b"XZY");
        t.delete(0, 1);
        assert_eq!(t.read(0, 10, b""), b"ZY");
    }
}
