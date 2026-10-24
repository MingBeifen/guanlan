// 本小检索（2026-10-19）：纯 JS 倒排 + BM25，零依赖、不调模型、不占显存。
// 作用：从「档案五页 + 旧日子账 + 事件卡」里捞最相关的三段，每段带来源和日期，
// 拼进每轮的记性块后面当参考；答之前仍然回档案页核，检索结果不当事实来源。
// 用法：
//   import { search } from './memo-search.mjs'
//   search(homeDir, '问题', { limit: 3, maxChars: 800 }) -> [{ source, date, text, score }]
//   命令行：node memo-search.mjs "问题"   （打印结果，离线测用）

import fs from 'node:fs';
import path from 'node:path';

const CJK_RE = /[\u3400-\u9fff]/;
const SEP_RE = /[\s\p{P}\p{S}]+/u;

// 归一化：全角转半角、小写、去控制符
function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ');
}

// 切词：中文按二字一组，英文数字按词；都去掉停用感太强的单字
const STOP = new Set([
  '的了', '是在', '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些',
  '什么', '么时', '时候', '怎么', '为什', '多少', '哪几', '哪个', '哪些', '几个',
  '可以', '不是', '就是', '没有', '一个', '现在', '今天', '昨天', '明天', '的是',
  '了吗', '了没', '还是', '但是', '因为', '所以', '如果', '然后', '这样', '那样',
  '么样', '怎样', '一下', '有点', '这不', '是不', '么办',
  '我在', '你在', '他在', '她在', '这是', '那是', '还有', '也没', '不用',
]);
function tokenize(text) {
  const t = norm(text);
  const out = [];
  let cjk = '';
  let latin = '';
  const flushCjk = () => {
    if (!cjk) return;
    const chars = [...cjk];
    if (chars.length === 1) out.push(chars[0]);
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    cjk = '';
  };
  const flushLatin = () => {
    if (latin) {
      out.push(latin);
      latin = '';
    }
  };
  for (const ch of t) {
    if (CJK_RE.test(ch)) {
      flushLatin();
      cjk += ch;
    } else if (/[a-z0-9_]/.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return out.filter((w) => w.length >= 2 && !STOP.has(w));
}

// ---------- 语料 ----------

const DAY_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

function pushDoc(docs, { source, date, text, weight = 1 }) {
  const clean = String(text ?? '').replace(/\r/g, '').trim();
  if (!clean) return;
  docs.push({ source, date: date || '', text: clean, weight });
}

// 档案页：按空行切段，太碎的并起来，太长的再按行切
function splitSections(raw) {
  const secs = [];
  let cur = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      if (cur.length) {
        secs.push(cur.join('\n').trim());
        cur = [];
      }
    } else cur.push(line);
  }
  if (cur.length) secs.push(cur.join('\n').trim());
  // 合并到每段不超过 600 字
  const merged = [];
  let acc = '';
  for (const s of secs) {
    if (!s) continue;
    if (acc && acc.length + s.length > 300) {
      merged.push(acc);
      acc = s;
    } else acc = acc ? acc + '\n' + s : s;
  }
  if (acc) merged.push(acc);
  return merged;
}

function collectDocs(home) {
  const docs = [];

  // 1) 档案五页（不含历史档案）
  const arcDir = path.join(home, '档案');
  try {
    for (const f of fs.readdirSync(arcDir)) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      const raw = fs.readFileSync(path.join(arcDir, f), 'utf8');
      const title = raw.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() || f;
      for (const sec of splitSections(raw)) {
        pushDoc(docs, { source: `档案·${title}`, date: '', text: sec, weight: 1.25 });
      }
    }
  } catch { /* 没有档案目录就跳过 */ }

  // 2) 旧日子账：按 ## 日期切
  const archDir = path.join(home, 'archive');
  try {
    for (const f of fs.readdirSync(archDir)) {
      if (!f.endsWith('.ledger.md')) continue;
      // 来源带上会话：全解开以后群里也会翻到别的群和私聊的账，得看得出是哪边的
      const which = f.startsWith('group_')
        ? `群${f.replace(/^group_/, '').replace(/\.ledger\.md$/, '')}日子账`
        : '私聊日子账';
      const lines = fs.readFileSync(path.join(archDir, f), 'utf8').replace(/\r/g, '').split('\n');
      let day = '';
      let body = [];
      const flush = () => {
        if (body.length) pushDoc(docs, { source: `${which}`, date: day, text: body.join('\n'), weight: 1.05 });
        body = [];
      };
      for (const line of lines) {
        const m = line.match(DAY_RE);
        if (m) {
          flush();
          day = m[1];
        } else body.push(line);
      }
      flush();
    }
  } catch { /* 没账本就算了 */ }

  // 3) 事件卡：一个文件一段
  const daysDir = path.join(archDir, 'days');
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const raw = fs.readFileSync(p, 'utf8').replace(/\r/g, '');
        const day = (raw.match(/日期：(\d{4}-\d{2}-\d{2})/)?.[1]) || path.basename(path.dirname(p));
        // 来源带上会话号：群里翻旧账时能看出这张卡是私聊的还是哪个群的
        const m = /(group|private)_(\d+)/.exec(p);
        const who = m
          ? m[1] === 'group'
            ? `群${m[2]}事件卡`
            : '私聊事件卡'
          : '事件卡';
        // 只取「一句话 + 原话」，别把标题等噪音塞进去
        const text = raw
          .split('\n')
          .filter((l) => l.startsWith('- 「') || l.startsWith('一句话：'))
          .join('\n');
        pushDoc(docs, { source: who, date: day, text: text || raw, weight: 0.7 });
      }
    }
  };
  walk(daysDir);

  return docs;
}

// 索引缓存：文件没变就不重建
let CACHE = { sig: '', index: null };

function sourceSig(home) {
  const parts = [];
  const addDir = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) addDir(p, depth + 1);
      else {
        try {
          const st = fs.statSync(p);
          parts.push(`${e.name}:${st.size}:${st.mtimeMs}`);
        } catch { /* 被占用就算了 */ }
      }
    }
  };
  addDir(path.join(home, '档案'));
  addDir(path.join(home, 'archive'));
  return parts.sort().join('|');
}

function buildIndex(home) {
  const docs = collectDocs(home);
  const postings = new Map(); // token -> [[docIdx, tf], ...]
  let totalLen = 0;
  docs.forEach((d, i) => {
    const toks = tokenize(d.text);
    d.len = toks.length;
    totalLen += d.len;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([i, n]);
    }
  });
  const avgLen = docs.length ? totalLen / docs.length : 1;
  return { docs, postings, avgLen };
}

function getIndex(home) {
  const sig = sourceSig(home);
  if (sig !== CACHE.sig || !CACHE.index) {
    CACHE = { sig, index: buildIndex(home) };
  }
  return CACHE.index;
}

// BM25
const K1 = 1.5;
const B = 0.75;

export function search(home, query, opts = {}) {
  const limit = opts.limit ?? 3;
  const maxChars = opts.maxChars ?? 800;
  const minScore = opts.minScore ?? 0.8;
  const qToks = [...new Set(tokenize(query))];
  if (!qToks.length) return [];
  const { docs, postings, avgLen } = getIndex(home);
  const N = docs.length;
  const scores = new Map();
  const cover = new Map(); // 每段命中了几个不同的查询词，只靠一个常见词撞上的不算
  for (const q of qToks) {
    const plist = postings.get(q);
    if (!plist) continue;
    const df = plist.length;
    // 命中超过一成的段，说明这个词满本子都有（「我在」「什么」这类），靠它分辨不出东西
    if (df > N * 0.1) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [i, tf] of plist) {
      const d = docs[i];
      const denom = tf + K1 * (1 - B + (B * d.len) / avgLen);
      const s = (idf * tf * (K1 + 1)) / denom;
      scores.set(i, (scores.get(i) || 0) + s * (d.weight || 1));
      if (!cover.has(i)) cover.set(i, new Set());
      cover.get(i).add(q);
    }
  }
  // 长问句要命中至少两个不同词才算相关；短问句（「我在备考什么」这种）放宽到一个，
  // 靠下面的分数门槛挡噪音，不然短问题一条都捞不到。
  const minCover = qToks.length >= 6 ? 2 : 1;
  for (const [i] of scores) {
    if ((cover.get(i)?.size ?? 0) < minCover) scores.delete(i);
  }
  const sorted = [...scores.entries()]
    .map(([i, s]) => ({ i, s }))
    .sort((a, b) => b.s - a.s);
  // 相对门槛：顶尖分太低就说明这问题跟旧账没关系，宁可不给；够高才留，避免每轮塞噪音
  const top = sorted[0]?.s ?? 0;
  const floor = Math.max(minScore, top * 0.45);
  const ranked = sorted.filter((x) => x.s >= floor).slice(0, limit);
  return ranked.map(({ i, s }) => {
    const d = docs[i];
    return {
      source: d.source,
      date: d.date,
      text: d.text.length > 360 ? d.text.slice(0, 360) + '…' : d.text,
      score: Number(s.toFixed(2)),
    };
  });
}

// 拼成一段给本体看的文字（带来源、日期）
export function retrieveText(home, query, opts = {}) {
  const maxChars = opts.maxChars ?? 800;
  const hits = search(home, query, opts);
  if (!hits.length) return '';
  const out = [];
  let used = 0;
  for (const h of hits) {
    const label = `来源：${h.source}${h.date ? ' · ' + h.date : ''}`;
    const block = `${label}\n${h.text}`;
    if (used + block.length > maxChars && out.length) break;
    out.push(block);
    used += block.length;
  }
  return out.join('\n\n');
}

// ---------- 命令行（离线测） ----------
if (process.argv[1] && process.argv[1].endsWith('memo-search.mjs')) {
  const home = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const q = process.argv.slice(2).join(' ');
  if (!q) {
    console.log('用法: node memo-search.mjs "问题"');
    process.exit(0);
  }
  const hits = search(home, q);
  if (!hits.length) console.log('（没捞到，分数不到门槛）');
  for (const h of hits) console.log(`[${h.score}] 来源：${h.source}${h.date ? ' · ' + h.date : ''}\n${h.text}\n`);
}
