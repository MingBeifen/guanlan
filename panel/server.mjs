// 本地控制面板：只看本机，绑 127.0.0.1，不连外面。
// 双击「openpanel.bat」跑这个，浏览器会自动打开 http://127.0.0.1:8790
// 功能：看状态 / 启动 停止 重启 / 看日志 / 换模型（换完自动重启，不动别的东西）。

import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, writeProfile, activeModel, fallbackModel } from '../bin/profile.mjs';
// 本地转发口：桌面 DSH 里 dsh-our-free-model 挂的 OpenAI 兼容网关（默认 127.0.0.1:8326）
// 它同时供给白嫖渠道（workbuddy/trae/qoder…）、免费车道和 deepseek-official。
import { gatewayStatus, gatewayKey, gatewayBase, isGatewayModel, providerLabel } from './gateway.mjs';
// 记忆库：面板和机器人共用 home\memory\store.json（2026-10-21 主人要的五层 + 打分 + 淡忘）
import * as memStore from '../bot/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(RUNTIME, { recursive: true });
memStore.initMemoryStore(path.join(ROOT, 'home'));

// 工作记忆：机器人每轮把实际拼进提示词的几块写在 runtime\memory-last.json
function memoryLast() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNTIME, 'memory-last.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 向量索引状态：记忆库条目也已经进索引，这里给面板显示「N 块 · 什么时候同步的」
const VEC_FILE = path.join(ROOT, 'home', 'memory', 'vectors', 'index.json');
let vecCache = { mtimeMs: 0, info: null };
function vectorStats() {
  try {
    const st = fs.statSync(VEC_FILE);
    if (vecCache.mtimeMs === st.mtimeMs && vecCache.info) return vecCache.info;
    const data = JSON.parse(fs.readFileSync(VEC_FILE, 'utf8'));
    const storeCount = (data.items || []).filter((it) => String(it.id || '').startsWith('store:')).length;
    vecCache = {
      mtimeMs: st.mtimeMs,
      info: {
        count: data.count || (data.items || []).length,
        storeCount,
        dim: data.dim,
        model: data.model,
        builtAt: data.builtAt,
        syncedAt: data.syncedAt || null,
        mtime: st.mtimeMs,
        sizeMB: Number((st.size / 1048576).toFixed(2)),
      },
    };
    return vecCache.info;
  } catch {
    return null;
  }
}

// 保存/删除记忆后起一个后台子进程做增量补索引（几秒，不占面板进程的内存）
function spawnVectorSync(full = false) {
  try {
    const script = path.join(ROOT, 'home', 'memory', 'vector-memory.mjs');
    const child = spawn(process.execPath, [script, full ? 'build' : 'sync'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const readPid = (f) => {
  try { return Number(fs.readFileSync(path.join(RUNTIME, f), 'utf8').trim()) || 0; } catch { return 0; }
};
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

/** 日志文件末尾 n 行（读不到就是空串）。 */
function tailLog(file, n) {
  try {
    const buf = fs.readFileSync(path.join(LOGS, file), 'utf8').trimEnd().split('\n');
    return buf.slice(-n).join('\n');
  } catch {
    return '';
  }
}

/** 机器人 pid 文件的 mtime ≈ 这轮启动时间。 */
function botSince() {
  try { return fs.statSync(path.join(RUNTIME, 'bot.pid')).mtimeMs; } catch { return null; }
}

// 主人睡（2026-10-20 的老功能）：机器人把状态写进 home\state\proactive.json，
// 面板只读文件，不跟机器人进程打交道。
// 2026-10-25：心情/氛围/主动生活的字段也一并读出来（原来只给 asleep/busy/mood 三样，
// 面板上除了概览一无所知，主人在概览里根本看不到「她现在心情几分」）。
function sleepState() {
  let pro = {};
  try {
    pro = JSON.parse(fs.readFileSync(path.join(ROOT, 'home', 'state', 'proactive.json'), 'utf8')) || {};
  } catch { /* 还没跑过就是空 */ }
  return {
    asleep: Boolean(pro.asleep),
    sleepKind: pro.sleepKind || '',
    sleepNote: pro.sleepNote || '',
    sleepSince: pro.sleepSince || null,
    // 心情（顺手给概览用，反正已经读了）
    mood: Number.isFinite(Number(pro.mood)) ? Number(pro.mood) : null,
    moodAt: pro.moodAt || null,
    busy: Boolean(pro.busy),
    busyNote: pro.busyNote || '',
    // 氛围偏移（Alter），超阈值才注入；负=闷、正=轻快
    alterScore: Number.isFinite(Number(pro.alterScore)) ? Number(pro.alterScore) : 0,
    alterNote: pro.alterNote || '',
    // 三档问候各自的最后一天 + 该补没补的那一档
    greet: pro.greet || {},
    pendingGreet: pro.pendingGreet || null,
    // 她自己做的事：今天有没有找事/做梦（日期口径，不是时间戳）
    ownDay: pro.ownDay || '',
    lastOwnAt: pro.lastOwnAt || null,
    planDay: pro.planDay || '',
    nightDay: pro.nightDay || '',
    // 群内沉默标签（2026-10-25 主人要的）：只列还没过期的，
    // 过期项机器人自己会在读的时候清掉，这里不重复写盘。
    groupMute: (() => {
      const out = [];
      const now = Date.now();
      const map = pro.groupMute;
      if (!map || typeof map !== 'object') return out;
      for (const gid of Object.keys(map)) {
        const s = map[gid] || {};
        const until = Number(s.until) || 0;
        if (until && now >= until) continue; // 已过期，不用显示
        out.push({
          group: Number(gid),
          until: until || null,
          at: Number(s.at) || null,
          note: String(s.note || ''),
        });
      }
      return out;
    })(),
  };
}

/** 读一份 JSON，读不到给 fallback（面板里到处要用）。 */
function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/**
 * 用户画像列表（home\画像\*.md，每晚模型归纳一次）。
 * 文件名就是「昵称-【QQ号】.md」，正文开头有一行 <!-- profile {...} --> 带统计。
 * 这里只取列表与元信息，正文按需单独取（别一次全塞给前端）。
 */
function profileList() {
  const dir = path.join(ROOT, 'home', '画像');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return { dir, items: [], total: 0, updatedAt: null, msgs: 0 };
  }
  const items = [];
  let updatedAt = null;
  let msgs = 0;
  for (const n of names) {
    let meta = null;
    let size = 0;
    try {
      const p = path.join(dir, n);
      size = fs.statSync(p).size;
      // 只读开头 1KB 找那行 <!-- profile ... -->，别整份读
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(1024);
      const got = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, got).toString('utf8');
      const m = head.match(/<!--\s*profile\s*(\{[\s\S]*?\})\s*-->/);
      if (m) meta = JSON.parse(m[1]);
    } catch {
      /* 单份读不了就只给文件名 */
    }
    const title = (meta && meta.nick) || n.replace(/-\u3010?\d+\u3011?\.md$/, '');
    const qq = (meta && meta.qq) || (n.match(/(\d{5,})/) || [])[1] || '';
    if (meta && Number.isFinite(Number(meta.updatedAt))) {
      updatedAt = Math.max(updatedAt || 0, Number(meta.updatedAt));
    }
    if (meta && Number.isFinite(Number(meta.msgs))) msgs += Number(meta.msgs);
    items.push({
      file: n,
      nick: title,
      qq,
      msgs: meta ? Number(meta.msgs) || 0 : null,
      updatedAt: meta ? Number(meta.updatedAt) || null : null,
      aliases: Array.isArray(meta?.aliases) ? meta.aliases : [],
      size,
    });
  }
  // 消息多的排前面（画像价值高的先看到）
  items.sort((a, b) => (b.msgs || 0) - (a.msgs || 0));
  return { dir, items, total: items.length, updatedAt, msgs };
}

/** 单份画像正文（点开某个人时取）。只允许读画像目录下的 .md，挡住路径穿越。 */
function profileOne(file) {
  const base = path.basename(String(file || ''));
  if (!base.endsWith('.md')) return null;
  const p = path.join(ROOT, 'home', '画像', base);
  try {
    return { file: base, text: fs.readFileSync(p, 'utf8') };
  } catch {
    return null;
  }
}

/** 提醒列表（home\reminders.json）：到点由机器人发，面板只读。 */
function reminderList() {
  const raw = readJsonFile(path.join(ROOT, 'home', 'reminders.json'), []);
  const arr = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  const items = arr.map((r) => {
    const at = Date.parse(String(r?.at ?? ''));
    const ms = Number.isFinite(at) ? at - now : null;
    return {
      id: r?.id || '',
      at: r?.at || '',
      content: String(r?.content || ''),
      toUser: r?.toUser || null,
      createdAt: r?.createdAt || '',
      // 还有多久：负数=已经过期（机器人最多补发 24 小时，太老的会丢弃）
      inMs: ms,
      due: ms !== null && ms <= 0,
    };
  });
  items.sort((a, b) => (a.inMs ?? Infinity) - (b.inMs ?? Infinity));
  return { items, total: items.length, due: items.filter((x) => x.due).length };
}

/** 昨晚做的梦（home\memory\dreams.jsonl）。这是「不是真事」的东西，单独一页看。 */
function dreamList(limit = 20) {
  const p = path.join(ROOT, 'home', 'memory', 'dreams.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return { items: [], total: 0, told: null };
  }
  const items = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      items.push({
        at: o.at || null,
        day: o.day || '',
        text: String(o.text || ''),
        materialCount: o.materialCount ?? null,
        status: o.status || '',
        isGroundTruth: o.isGroundTruth === true,
      });
    } catch {
      /* 坏行跳过 */
    }
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  const state = readJsonFile(path.join(ROOT, 'home', 'state', 'dream.json'), {});
  return { items: items.slice(0, limit), total: items.length, told: state?.lastToldDay || null };
}

/**
 * 记忆质量门留档（home\memory\rejected.jsonl）。
 * 这是审计用的：看「她本来会记什么、被哪条规则拦下了」。
 * 文件可能不存在（上线后还没真拦过一条），这种情况要明确说「没有」而不是报错。
 */
function rejectedList(limit = 50) {
  const p = path.join(ROOT, 'home', 'memory', 'rejected.jsonl');
  const files = [p, p + '.1', p + '.2'];
  let exists = false;
  const items = [];
  for (const f of files) {
    let lines = [];
    try {
      lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      exists = true;
    } catch {
      continue;
    }
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        items.push({
          at: o.at || null,
          key: o.key || '',
          day: o.day || '',
          text: String(o.text || ''),
          reason: o.reason || '',
          quality: o.quality ?? null,
          source: o.source || '',
        });
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  const byReason = {};
  for (const it of items) byReason[it.reason || '(未写原因)'] = (byReason[it.reason || '(未写原因)'] || 0) + 1;
  return {
    exists,
    items: items.slice(0, limit),
    total: items.length,
    byReason,
    note: exists ? '' : '还没有被拦下的条目（质量门上线后抽记忆次数还很少）',
  };
}

function readHalt() {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME, 'supervisor-halt.json'), 'utf8')); } catch { return null; }
}

function status() {
  const cfg = loadConfig() || {};
  const sup = readPid('supervisor.pid');
  const bot = readPid('bot.pid');
  const since = botSince();
  const m = activeModel(cfg);
  return {
    running: alive(sup),
    botAlive: alive(bot),
    supervisorPid: sup,
    botPid: bot,
    since,
    bot: { qq: cfg.bot?.qq || 0, name: cfg.bot?.name || '', names: cfg.bot?.names || [], owners: cfg.bot?.owners || [] },
    group: cfg.group || { enabled: false, allow: [] },
    model: m ? { name: m.name, model: m.model, baseURL: m.baseURL, hasKey: Boolean(m.apiKey) } : null,
    models: (cfg.models || []).map((x, i) => ({ i, name: x.name, model: x.model })),
    activeModel: Number(cfg.activeModel) || 0,
    fallback: fallbackState(cfg),
    dsh: cfg.dsh || {},
    sleep: sleepState(),
    halt: readHalt(),
    log: tailLog('supervisor.log', 80),
    botLog: tailLog('whale-bot.log', 40),
  };
}

// 模型兜底状态（2026-10-21 加的）：主模型调不动时机器人会自动退到官方 DeepSeek Flash，
// 冷却期内每轮直接用兜底、不再白试。界面要把这两件事显示出来，否则用户会以为「明明选的免费模型怎么在花官方额度」。
function fallbackState(cfg) {
  const list = cfg.models || [];
  const fb = list.find((x) => x && x.fallback === true) || fallbackModel(cfg);
  let until = 0;
  try {
    until = Number(JSON.parse(fs.readFileSync(path.join(RUNTIME, 'model-cooldown.json'), 'utf8'))?.until) || 0;
  } catch { /* 没冷却文件就是没在冷却 */ }
  const left = until > Date.now() ? until - Date.now() : 0;
  return {
    enabled: Boolean(fb && fb.apiKey),
    name: fb?.name || 'DeepSeek Flash（官方兜底）',
    model: fb?.model || 'deepseek-flash',
    baseURL: fb?.baseURL || 'https://api.deepseek.com/v1',
    cooling: left > 0,
    coolingLeftMs: left,
    coolingUntil: until || null,
    // 现在这一轮实际会用哪个：冷却中就是兜底，否则是 activeModel
    activeNow: left > 0 ? 'fallback' : 'main',
  };
}

/**
 * 把 cfg.activeModel 切到第 i 条，写盘、重写 profile，机器人在跑就重启。
 * 面板的「换模型」和「用转发口模型」原来各抄了一遍这五句。
 */
function switchToModel(cfg, i) {
  cfg.activeModel = i;
  saveConfig(cfg);
  writeProfile(cfg);
  const was = alive(readPid('supervisor.pid'));
  if (was) { markRestart('panel'); stopBot(); startBot(); }
  return was;
}

/** config.json 里已经指向本地网关的模型：model id → 下标。 */
function gatewayUsage(cfg) {
  const used = {};
  (Array.isArray(cfg?.models) ? cfg.models : []).forEach((m, i) => {
    if (isGatewayModel(m)) used[m.model] = i;
  });
  return used;
}

function startBot() {
  if (alive(readPid('supervisor.pid'))) return { ok: true, msg: '已经在跑了' };
  // 手动点「启动」= 上一回停手的记录作废，重新给它五次机会
  fs.rmSync(path.join(RUNTIME, 'supervisor-halt.json'), { force: true });
  spawn(process.execPath, [path.join(ROOT, 'bin', 'start.mjs'), '--detach'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  return { ok: true, msg: '已让它起来，等几秒刷新' };
}

// 面板点重启时留个记号：机器人起来后靠它说准「这回是面板点的重启」（2026-10-22）。
// 机器人读用过会自己撕掉，五分钟内有效。
function markRestart(by) {
  try {
    const dir = path.join(ROOT, 'home', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'restart-asked.json'),
      JSON.stringify({ at: Date.now(), by }) + '\n',
      'utf8',
    );
  } catch { /* 记不上只是那句话说得糙点，不影响重启 */ }
}

function stopBot() {
  const sup = readPid('supervisor.pid');
  const bot = readPid('bot.pid');
  // 看门人只杀它自己（不加 /T）：面板是它顺手拉起来的子进程，/T 会把面板一起带走。
  if (sup) spawnSync('taskkill', ['/PID', String(sup), '/F'], { windowsHide: true });
  killTree(bot);
  fs.rmSync(path.join(RUNTIME, 'supervisor.pid'), { force: true });
  fs.rmSync(path.join(RUNTIME, 'bot.pid'), { force: true });
  return { ok: true, msg: '停了' };
}

const PROGRESS = path.join(RUNTIME, 'progress');

// 任务进度（2026-10-20 方案 A）：机器人每跑一轮会写一份快照在这里，面板只读文件，不跟机器人进程打交道。
function progressData() {
  const list = [];
  try {
    for (const f of fs.readdirSync(PROGRESS)) {
      if (!f.endsWith('.json')) continue;
      try { list.push(JSON.parse(fs.readFileSync(path.join(PROGRESS, f), 'utf8'))); } catch { /* 半份文件跳过 */ }
    }
  } catch { /* 还没跑过任务 */ }
  const running = list.filter((p) => !p.done).sort((a, b) => b.startedAt - a.startedAt);
  const recent = list.filter((p) => p.done).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const turns = [];
  try {
    const lines = fs.readFileSync(path.join(LOGS, 'turns.jsonl'), 'utf8').trim().split('\n').slice(-12);
    for (const l of lines) { try { turns.push(JSON.parse(l)); } catch { /* 坏行跳过 */ } }
  } catch { /* 还没有记账文件 */ }
  return { now: Date.now(), running, recent, turns: turns.reverse() };
}

// ---- DSH 会话回放（2026-10-20 路线 1）----
// DSH 把每轮事件写进 <DSH_HOME>/sessions/--<工作区>--/<会话id>/session.v4.jsonl.zstd。
// 这个文件是逐帧追加的 zstd：整解只出第一帧，所以要按帧头魔数切段、逐帧解压再拼成 JSONL。
// 面板只读这些文件，不碰机器人进程；文件正在写时最后一帧可能半截，解不开就等下次。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH_HOME, 'sessions');
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const sessCache = new Map(); // 文件路径 -> { end: 已解到哪个字节, lines: [...], tr: 归一化后的话 ]

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} 字)` : s;
};

function decodeFrames(buf, from) {
  const offs = [];
  let i = from;
  while (true) {
    const p = buf.indexOf(ZMAGIC, i);
    if (p < 0) break;
    offs.push(p);
    i = p + 1;
  }
  const lines = [];
  let next = from;
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k];
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try {
      const s = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      for (const l of s.split('\n')) if (l) lines.push(l);
      next = end;
    } catch {
      next = start; // 半截帧，下次再解
      break;
    }
  }
  return { lines, next };
}

function buildTranscript(lines) {
  const rows = [];
  const toolIdx = new Map();
  let title = '', cwd = '', turn = 0, turnStart = 0, steps = 0, lastType = '', lastTime = 0, firstLine = '';
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    lastType = e.type;
    if (e.time) lastTime = e.time;
    const d = e.data || {};
    switch (e.type) {
      case 'session':
        cwd = d.cwd || cwd;
        break;
      case 'session/title':
        if (d.title && (d.source?.kind !== 'fallback' || !title)) title = d.title;
        break;
      case 'turn/start':
        turn = d.turn || turn + 1;
        turnStart = e.time;
        steps = 0;
        rows.push({ k: 'turn', t: e.time, n: turn });
        break;
      case 'step/start':
        steps = Math.max(steps, d.step || 0);
        break;
      case 'user/message': {
        const raw = (d.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
        if (!raw || raw.startsWith('<system-reminder>')) break;
        // QQ 会话的提示词包了一堆上下文，读起来太吵：只取「主人通过 QQ 说：」之后她自己那句
        let text = raw;
        const mark = '[主人通过 QQ 说：]';
        const at = text.indexOf(mark);
        if (at >= 0) text = text.slice(at + mark.length).trim();
        const meta = at < 0 && /^(Current runtime context|你正在|This is a reminder)/.test(text);
        if (!firstLine) {
          const cand = text.split('\n').map((s) => s.trim()).filter((s) => s && !/^[\[\]\-*>#]/.test(s) && !s.startsWith('当前时间'));
          if (cand.length) firstLine = cand[0].slice(0, 30);
        }
        rows.push({ k: 'user', t: e.time, text: clip(text, 6000), meta });
        break;
      }
      case 'assistant/message':
        for (const p of d.message?.content || []) {
          if (p.type === 'reasoning' && p.text) rows.push({ k: 'think', t: e.time, text: clip(p.text, 2500) });
          else if (p.type === 'text' && p.text) rows.push({ k: 'assistant', t: e.time, text: clip(p.text, 6000) });
          else if (p.type === 'tool-call') {
            const r = { k: 'tool', t: e.time, id: p.id, name: p.name || 'tool', args: clip(p.arguments, 900), out: '', ok: null };
            rows.push(r);
            toolIdx.set(p.id, r);
          }
        }
        break;
      case 'tool/result': {
        const msg = d.message || d;
        const text = (msg.content || d.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const id = d.toolCallId || msg.toolCallId || msg.source?.callId;
        const r = toolIdx.get(id);
        if (r) { r.out = clip(text, 2500); }
        else rows.push({ k: 'tool', t: e.time, name: '工具结果', args: '', out: clip(text, 2500), ok: null });
        break;
      }
      case 'job/settled': {
        const r = toolIdx.get(d.toolCall?.callId);
        if (r) {
          r.ok = d.status === 'completed';
          if (d.detail && r.ok === false) r.out = clip(`${r.out}\n[${d.status}] ${d.detail}`, 2500);
        }
        break;
      }
      case 'turn/end':
        rows.push({ k: 'turnend', t: e.time, n: d.turn || turn, ms: e.time - turnStart, steps, reason: d.reason?.kind || '' });
        break;
      case 'compaction/start':
        rows.push({ k: 'note', t: e.time, text: '—— 上下文压缩 ——' });
        break;
      case 'todo/write':
        if (Array.isArray(d.todos)) rows.push({ k: 'todo', t: e.time, todos: d.todos });
        break;
      default:
        break;
    }
  }
  if (!title || title.startsWith('[')) title = firstLine || title;
  const running = Boolean(lastType) && lastType !== 'turn/end' && Date.now() - lastTime < 120000;
  return { title, cwd, rows, total: rows.length, running, lastType, lastTime };
}

function getSession(file) {
  const st = fs.statSync(file);
  let c = sessCache.get(file);
  if (!c || st.size < c.end) {
    c = { end: 0, lines: [], tr: null };
    sessCache.set(file, c);
  }
  if (st.size > c.end) {
    const buf = fs.readFileSync(file);
    const r = decodeFrames(buf, c.end);
    if (r.lines.length) {
      c.lines.push(...r.lines);
      c.tr = null;
    }
    c.end = r.next;
  }
  if (!c.tr) c.tr = buildTranscript(c.lines);
  return { st, tr: c.tr };
}

function listSessions(n = 20) {
  const out = [];
  let wsDirs = [];
  try {
    wsDirs = fs.readdirSync(SESS_ROOT, { withFileTypes: true }).filter((x) => x.isDirectory());
  } catch {
    return out;
  }
  for (const ws of wsDirs) {
    const wsPath = path.join(SESS_ROOT, ws.name);
    let sids = [];
    try {
      sids = fs.readdirSync(wsPath, { withFileTypes: true }).filter((x) => x.isDirectory());
    } catch {
      continue;
    }
    for (const sid of sids) {
      const file = path.join(wsPath, sid.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(file);
        out.push({ ws: ws.name, sid: sid.name, file, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* 没这个会话文件 */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out
    .slice(0, 40)
    .map((x) => {
      let title = '', running = false, total = 0;
      try {
        const { tr } = getSession(x.file);
        title = tr.title || '';
        running = tr.running;
        total = tr.total;
      } catch {
        /* 单个会话坏了不影响别的 */
      }
      return { ws: x.ws, sid: x.sid, title, running, total, size: x.size, mtime: x.mtime };
    })
    .filter((x) => x.total > 0)
    .slice(0, n);
}

const SAFE = /^[A-Za-z0-9_.\-]+$/;
function sessionFile(ws, sid) {
  if (!SAFE.test(ws || '') || !SAFE.test(sid || '') || !sid.startsWith('session-')) return '';
  const file = path.join(SESS_ROOT, ws, sid, 'session.v4.jsonl.zstd');
  const rel = path.relative(SESS_ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return fs.existsSync(file) ? file : '';
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); }
  });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'panel', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // 面板自己的静态小文件（图标之类）：只认 /image/ 下的扁平文件名，不许带子目录或 ..
    if (url.pathname.startsWith('/image/')) {
      const name = url.pathname.slice('/image/'.length);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
        return json(res, 404, { ok: false, msg: '没有这个地址' });
      }
      const file = path.join(ROOT, 'panel', 'image', name);
      try {
        const buf = fs.readFileSync(file);
        const type = name.endsWith('.ico') ? 'image/x-icon'
          : name.endsWith('.png') ? 'image/png'
          : name.endsWith('.svg') ? 'image/svg+xml'
          : name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
        return res.end(buf);
      } catch {
        return json(res, 404, { ok: false, msg: '没有这个地址' });
      }
    }
    if (url.pathname === '/api/status') return json(res, 200, status());
    if (url.pathname === '/api/progress') return json(res, 200, progressData());
    // ---- 记忆库（五层 + 打分 + 淡忘）----
    if (url.pathname === '/api/memory') {
      const layer = url.searchParams.get('layer') || '';
      const q = url.searchParams.get('q') || '';
      const key = url.searchParams.get('key') || '';
      const items = memStore.listItems({ layer: layer || undefined, q: q || undefined, key: key || undefined, limit: 500 });
      // 条目互联：links 存的是 id，链到的那条可能被当前筛选挡在外面（换层/搜索时），
      // 所以另给一份全库 id → 摘要，前端拿它译名字（2026-10-23）
      // listItems 默认把冷藏和旧版（superseded）都筛掉了，这里要补上，
      // 不然链子指向冷藏区那几条就又译不出名字
      const brief = {};
      const all = [
        ...memStore.listItems({ limit: 2000 }),
        ...memStore.listItems({ layer: 'cold', limit: 2000 }),
        ...memStore.listItems({ status: 'superseded', limit: 2000 }),
      ];
      for (const it of all) {
        brief[it.id] = {
          id: it.id,
          key: it.key,
          text: it.text,
          layer: it.layer,
          status: it.status,
          score: it.score,
          tags: it.tags,
          pinned: it.pinned,
        };
      }
      return json(res, 200, {
        ok: true,
        stats: memStore.stats(),
        layerLabel: memStore.LAYER_LABEL,
        items,
        brief,
        last: memoryLast(),
        vector: vectorStats(),
      });
    }
    if (url.pathname === '/api/memory/save' && req.method === 'POST') {
      const b = await body(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { ok: false, msg: '内容不能空' });
      const patch = {
        key: String(b.key || 'shared'),
        text,
        score: b.score,
        tags: String(b.tags || '')
          .split(/[,，、\s]+/)
          .filter(Boolean)
          .slice(0, 8),
        pinned: Boolean(b.pinned),
      };
      // 层只由分数决定（2026-10-23 主人定的）：前端传来的 b.layer 不再采信
      if (b.id) {
        const it = memStore.updateItem(b.id, patch);
        if (it) spawnVectorSync();
        return it ? json(res, 200, { ok: true, item: it, indexing: Boolean(it) }) : json(res, 404, { ok: false, msg: '没有这条记忆' });
      }
      const it = memStore.upsert({ ...patch, source: 'panel' });
      spawnVectorSync();
      return json(res, 200, { ok: true, item: it, indexing: true });
    }
    if (url.pathname === '/api/memory/delete' && req.method === 'POST') {
      const b = await body(req);
      const ok = memStore.removeItem(String(b.id || ''));
      if (ok) spawnVectorSync();
      return json(res, ok ? 200 : 404, { ok, indexing: ok });
    }
    if (url.pathname === '/api/memory/decay' && req.method === 'POST') {
      const r = memStore.decayAll();
      spawnVectorSync();
      return json(res, 200, { ok: true, ...r, stats: memStore.stats() });
    }
    if (url.pathname === '/api/memory/reindex' && req.method === 'POST') {
      return json(res, 200, { ok: true, building: spawnVectorSync(true), vector: vectorStats() });
    }
    // ---- 画像 / 提醒 / 梦 / 质量门留档（2026-10-25 主人要的四个盲区）----
    // 这四样数据本来就在盘上、也一直在长，只是面板没有入口，主人只能靠我口头汇报。
    if (url.pathname === '/api/profiles') return json(res, 200, { ok: true, ...profileList() });
    if (url.pathname === '/api/profile') {
      const one = profileOne(url.searchParams.get('file'));
      if (!one) return json(res, 404, { ok: false, msg: '找不到这份画像' });
      return json(res, 200, { ok: true, ...one });
    }
    if (url.pathname === '/api/reminders') return json(res, 200, { ok: true, ...reminderList() });
    if (url.pathname === '/api/dreams') return json(res, 200, { ok: true, ...dreamList(Number(url.searchParams.get('limit')) || 20) });
    if (url.pathname === '/api/rejected') return json(res, 200, { ok: true, ...rejectedList(Number(url.searchParams.get('limit')) || 50) });
    if (url.pathname === '/api/sessions') return json(res, 200, { now: Date.now(), sessions: listSessions(25) });
    if (url.pathname === '/api/session') {
      const file = sessionFile(url.searchParams.get('ws'), url.searchParams.get('sid'));
      if (!file) return json(res, 404, { ok: false, msg: '找不到这个会话' });
      const { st, tr } = getSession(file);
      const keep = Math.max(40, Number(url.searchParams.get('rows')) || 260);
      const rows = tr.rows.slice(-keep);
      return json(res, 200, {
        ok: true,
        title: tr.title,
        cwd: tr.cwd,
        running: tr.running,
        total: tr.total,
        hidden: tr.total - rows.length,
        size: st.size,
        mtime: st.mtimeMs,
        rows,
      });
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'start') return json(res, 200, startBot());
      if (b.action === 'stop') return json(res, 200, stopBot());
      if (b.action === 'restart') { markRestart('panel'); stopBot(); return json(res, 200, startBot()); }
      return json(res, 400, { ok: false, msg: '不认识的动作' });
    }
    // 重启面板自己（2026-10-23 主人要的概览页按钮）：先回话，再把旧进程放掉、
    // 由一个隔 1.2 秒的帮手拉起新的——不这样就会撞 8790 端口占用。
    if (url.pathname === '/api/panel/restart' && req.method === 'POST') {
      const helper = [
        "const {spawn}=require('node:child_process');",
        'setTimeout(()=>{',
        '  const p=spawn(process.execPath,' + JSON.stringify([path.join(ROOT, 'panel', 'server.mjs')]) + ',',
        '    {cwd:' + JSON.stringify(ROOT) + ',detached:true,stdio:"ignore",windowsHide:true,',
        '     env:{...process.env,PANEL_NO_OPEN:"1"}});',
        '  p.unref();',
        '},1200);',
      ].join('\n');
      try {
        spawn(process.execPath, ['-e', helper], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (e) {
        return json(res, 500, { ok: false, msg: '拉不起来：' + (e && e.message) });
      }
      json(res, 200, { ok: true, msg: '面板重启中，两秒后自己刷新' });
      res.on('finish', () => setTimeout(() => process.exit(0), 150));
      return;
    }
    if (url.pathname === '/api/model' && req.method === 'POST') {
      const b = await body(req);
      const cfg = loadConfig();
      const i = Number(b.index);
      if (!cfg || !cfg.models?.[i]) return json(res, 400, { ok: false, msg: '没有这个模型' });
      const was = switchToModel(cfg, i);
      return json(res, 200, { ok: true, msg: `换成「${cfg.models[i].name}」，${was ? '已重启' : '下次启动生效'}` });
    }
    if (url.pathname === '/api/gateway') {
      const st = await gatewayStatus();
      const cfg0 = loadConfig() || {};
      return json(res, 200, {
        ok: st.ok,
        ...st,
        key: undefined,
        using: gatewayUsage(cfg0),
        activeModel: Number(cfg0.activeModel) || 0,
      });
    }
    // 把网关里的某个模型写进 config.json 的 models[] 并切过去。
    // 同一个模型已在列表里就只切索引，不重复追加。
    if (url.pathname === '/api/gateway/use' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.model || '').trim();
      if (!id) return json(res, 400, { ok: false, msg: '没说要哪个模型' });
      const st = await gatewayStatus();
      const hit = (st.models || []).find((m) => m.id === id);
      if (!hit) return json(res, 400, { ok: false, msg: `网关里没有「${id}」这个模型` + (st.ok ? '' : '（网关现在连不上）') });
      const key = gatewayKey();
      if (!key) return json(res, 400, { ok: false, msg: '还没生成网关密钥，先在桌面 DSH 里打开 Our Free Model' });
      const cfg = loadConfig();
      if (!cfg) return json(res, 500, { ok: false, msg: '读不到 config.json' });
      if (!Array.isArray(cfg.models)) cfg.models = [];
      const label = `${providerLabel(hit.provider)} · ${hit.name || hit.id}`;
      let i = cfg.models.findIndex((m) => isGatewayModel(m) && String(m.model) === id);
      if (i < 0) {
        cfg.models.push({
          name: label,
          baseURL: gatewayBase(),
          apiKey: key,
          model: id,
          contextWindow: hit.contextWindow || 131072,
        });
        i = cfg.models.length - 1;
      } else {
        // 密钥会轮换，跟着更新，不然旧密钥会 401。
        cfg.models[i].apiKey = key;
        cfg.models[i].contextWindow = hit.contextWindow || cfg.models[i].contextWindow || 131072;
      }
      const was = switchToModel(cfg, i);
      return json(res, 200, {
        ok: true,
        index: i,
        model: id,
        name: label,
        msg: `换成「${label}」，${was ? '已重启' : '下次启动生效'}。注意：这个模型跑在桌面 DSH 的转发口上，桌面关了它就没模型。`,
      });
    }
    json(res, 404, { ok: false, msg: '没有这个地址' });
  } catch (e) {
    json(res, 500, { ok: false, msg: String(e?.message || e) });
  }
});

const cfg = loadConfig() || {};
const port = Number(process.env.PANEL_PORT || cfg.panel?.port) || 8790;

const NO_OPEN = process.env.PANEL_NO_OPEN === '1';

function openBrowser(url) {
  if (NO_OPEN) return; // 看门人顺手拉起来的那种，不抢浏览器焦点
  try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch { /* 自己开浏览器也行 */ }
}

// 重复双击「openpanel.bat」时端口会占用：这不是错误，直接把已经在跑的那个打开就行。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${port}`;
    console.log('面板已经在跑了：' + url);
    console.log('（这个窗口可以直接关掉）');
    openBrowser(url);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  console.error(e);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log('面板开着：' + url + '（关这个窗口就停）');
  openBrowser(url);
});
