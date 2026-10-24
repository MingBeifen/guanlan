// 档案五页「在不在索引里」的查法（2026-10-24 19:2x 修的）
// 原来 pages.mjs 和每周自检都去 home\archive\*.base.md 里找页名——那是老底账的位置。
// 2026-10-21 记忆搬进 home\memory\store.json + 向量库以后，底账就空了，
// 于是每逢查索引都误报「底账还没建」「索引里没挂」。
// 现在统一查真正装页的那本：home\memory\vectors\index.json 里 src 以「档案/页名.md」开头的块。
// 只做正则在文本里找 src，不把 25MB 的索引整个 JSON.parse 一遍。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VECTOR_INDEX_PATH = path.join(HOME, 'memory', 'vectors', 'index.json');

/**
 * 每个档案页在向量索引里占多少块。
 * @returns {{ok: boolean, counts: Map<string, number>, file: string, at: string, why: string}}
 */
export function pageIndexState() {
  const out = { ok: false, counts: new Map(), file: VECTOR_INDEX_PATH, at: '', why: '' };
  let raw = '';
  try {
    raw = fs.readFileSync(VECTOR_INDEX_PATH, 'utf8');
  } catch (e) {
    out.why = e && e.code === 'ENOENT' ? '向量索引还没建' : `向量索引读不到（${e?.code || e?.message}）`;
    return out;
  }
  try {
    out.at = fs.statSync(VECTOR_INDEX_PATH).mtime.toISOString();
  } catch {
    /* 时间读不到不影响判断 */
  }
  // JSON.stringify 不会转义中文，src 在文件里就是原样的「档案/A-学习与工作.md」
  const re = /"src":"档案\/([^"\\]+?)\.md"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1] + '.md';
    out.counts.set(name, (out.counts.get(name) || 0) + 1);
  }
  out.ok = true;
  return out;
}
