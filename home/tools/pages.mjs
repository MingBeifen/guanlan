// 档案翻页记录（加的）
// 用法：
//   node tools\pages.mjs 打开 A     翻一页，顺手记下时间，页面内容直接打印
//   node tools\pages.mjs 清单       每页上次翻是什么时候、隔了几天、索引里在不在
// 记录落在 档案\_翻页记录.json，只记「真翻过」的那一下，不做别的。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = path.join(HOME, '档案');
const LOG_PATH = path.join(PAGE_DIR, '_翻页记录.json');
const BASE_DIR = path.join(HOME, 'archive');
const MAX_DAYS = 30;

const pad = (n) => String(n).padStart(2, '0');

function nowISO() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
    + `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

function todayCST() {
  return nowISO().slice(0, 10);
}

function loadLog() {
  if (!fs.existsSync(LOG_PATH)) return {};
  const raw = fs.readFileSync(LOG_PATH, 'utf8').replace(/^\uFEFF/, '');
  const obj = JSON.parse(raw); // 坏了就抛，别拿空对象把旧记录盖掉
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('顶层不是对象');
  return obj;
}

function saveLog(log) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

function listPages() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PAGE_DIR, { withFileTypes: true });
  } catch {
    return []; // 档案目录还没建，当空处理，别直接报 ENOENT
  }
  return dirs
    .filter((d) => d.isFile() && /^[A-Z]\d*[-_— ].+\.md$/.test(d.name))
    .map((d) => d.name)
    .sort();
}

function resolvePage(arg) {
  const pages = listPages();
  const q = String(arg || '').trim();
  if (!q) return null;
  const exact = pages.find((p) => p === q || p === q + '.md');
  if (exact) return exact;
  const byPrefix = pages.filter((p) => p.toUpperCase().startsWith(q.toUpperCase()));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    console.error('对上好几页：' + byPrefix.join('、'));
    process.exit(1);
  }
  return null;
}

function baseIndexText() {
  try {
    const bases = fs.readdirSync(BASE_DIR).filter((f) => f.endsWith('.base.md')).sort();
    if (!bases.length) return '';
    return fs.readFileSync(path.join(BASE_DIR, bases[bases.length - 1]), 'utf8');
  } catch {
    return '';
  }
}

function daysSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86400000);
}

function fmtDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

function hhmm(iso) {
  return fmtDay(iso).slice(6);
}

function status() {
  const pages = listPages();
  const log = loadLog();
  const base = baseIndexText();
  if (!pages.length) {
    console.log('档案目录里一页也没找到：' + PAGE_DIR);
    return;
  }
  const stale = [];
  const since = log._since && log._since.last ? log._since.last : null;
  for (const name of pages) {
    const rec = log[name];
    const inIndex = base.includes(name);
    const parts = [name];
    if (!rec || !rec.last) {
      const d = since ? daysSince(since) : null;
      parts.push(d === null ? '从未翻过' : `从未翻过（记录起了 ${d} 天）`);
      if (d !== null && d >= MAX_DAYS) {
        stale.push(name);
        parts.push(`过了 ${MAX_DAYS} 天没动，该沉底`);
      }
    } else {
      const d = daysSince(rec.last);
      const old = d > 0 ? `${d} 天前` : '今天';
      parts.push(`上次 ${fmtDay(rec.last)}（${old}）`);
      if (rec.count > 1) parts.push(`共翻 ${rec.count} 次`);
      if (d !== null && d >= MAX_DAYS) {
        stale.push(name);
        parts.push(`过了 ${MAX_DAYS} 天，该沉底`);
      }
    }
    if (!base) parts.push('底账还没建，索引待建');
    else parts.push(inIndex ? '索引里有' : '索引里没有 ← 漏了');
    console.log('· ' + parts.join(' · '));
  }
  if (stale.length) console.log(`\n要沉底的：${stale.join('、')}（挪 档案\\历史档案\\ 并从底账索引删行）`);
}

function open(arg) {
  const name = resolvePage(arg);
  if (!name) {
    console.error('没认出是哪页：' + (arg || '(空)'));
    console.error('现在有的页：' + listPages().join('、'));
    process.exit(1);
  }
  const log = loadLog();
  if (!log._since || !log._since.last) log._since = { last: nowISO() };
  const rec = log[name] || { last: null, count: 0 };
  rec.last = nowISO();
  rec.count = (rec.count || 0) + 1;
  log[name] = rec;
  saveLog(log);

  const body = fs.readFileSync(path.join(PAGE_DIR, name), 'utf8');
  console.log(`=== ${name} · ${todayCST()} ${hhmm(rec.last)} 翻第 ${rec.count} 次 ===`);
  console.log(body.replace(/\s+$/, ''));
}

const cmd = (process.argv[2] || '').trim();
const arg = process.argv[3];

try {
  if (cmd === '打开' || cmd === 'open' || cmd === 'flip') open(arg);
  else if (cmd === '清单' || cmd === 'list' || cmd === 'status') status();
  else {
    console.log('用法：');
    console.log('  pages.mjs 打开 A      翻一页并记下时间');
    console.log('  pages.mjs 清单        看上次翻、隔几天、索引里在不在');
    console.log('');
    status();
  }
} catch (e) {
  console.error('出岔子了：' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
