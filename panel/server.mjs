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

// ---------- 她「选择不回」的账本（2026-10-26 主人要的面板新页面） ----------
// 数据由机器人写：home\state\skip-log.jsonl，一行一条。面板只读 + 聚合。
// **分两类看**：「她主动跳过」是她的自由度；「想跳但被硬消息闸拦下」是她的判断错误。
// 两类混在一起就看不出问题——所以 bucketed 分开统计，不合并成「今天跳过 N 次」。
const SKIP_LOG = path.join(ROOT, 'home', 'state', 'skip-log.jsonl');

function skipData({ days = 7, limit = 300 } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(SKIP_LOG, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return { ok: true, exists: false, days, total: 0, skipped: 0, blocked: 0, ownerSkips: 0, byDay: [], reasons: [], items: [], truncated: 0 };
  }
  const since = Date.now() - Math.max(1, days) * 86400000;
  const items = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.ts >= since) items.push(o);
    } catch {
      /* 坏行跳过 */
    }
  }
  items.reverse();
  const truncated = Math.max(0, items.length - limit);
  const view = truncated ? items.slice(-limit) : items;

  // 按天分桶：北京时间，与机器人的 logicalDay 凌晨四点线一致
  const dayOf = (ts) => {
    const d = new Date(ts + 8 * 3600 * 1000 - 4 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };
  const byDayMap = new Map();
  const reasonMap = new Map();
  let blocked = 0;
  let ownerSkips = 0;
  for (const o of items) {
    const day = dayOf(o.ts);
    const b = byDayMap.get(day) || { day, skip: 0, blocked: 0, owner: 0, group: 0 };
    if (o.blocked) {
      b.blocked += 1;
      blocked += 1;
    } else {
      b.skip += 1;
      if (o.owner) {
        b.owner += 1;
        ownerSkips += 1;
      } else b.group += 1;
    }
    byDayMap.set(day, b);
    // 原因归并：去掉括号补充，只留主类，免得几十个近义条目糊成一片
    const reason =
      String(o.reason || '未注明').replace(/[（(].*?[）)]/g, '').trim() || '未注明';
    const r = reasonMap.get(reason) || { reason, n: 0, blocked: 0 };
    r.n += 1;
    if (o.blocked) r.blocked += 1;
    reasonMap.set(reason, r);
  }
  return {
    ok: true,
    exists: true,
    now: Date.now(),
    days,
    total: items.length,
    skipped: items.length - blocked,
    blocked,
    ownerSkips,
    byDay: [...byDayMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    reasons: [...reasonMap.values()].sort((a, b) => b.n - a.n),
    items: view.slice().reverse(),
    truncated,
  };
}

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

// 重启流水账（2026-10-26 主人拍板的 C 档：面板补一页）。
// 机器人每次起来往 home\state\boots.jsonl 追加一行，这里只读。
// 为什么要它：面板原来对 boot 零命中——「她今天断过几次、最长断了多久、跑的是哪版代码」
// 在主人在的界面上一个字都看不到，只能翻日志。机器人那边有同一份数据，两边不能长得不一样。
const BOOT_LOG = path.join(ROOT, 'home', 'state', 'boots.jsonl');
function bootHistory(limit = 60) {
  let rows = [];
  try {
    rows = fs.readFileSync(BOOT_LOG, 'utf8')
      .split('\n')
      .filter((x) => x.trim())
      .map((x) => { try { return JSON.parse(x); } catch { return null; } })
      .filter(Boolean);
  } catch { /* 还没有流水账 = 改造上线后还没重启过 */ }
  const all = rows.slice(-Math.max(1, limit)).slice().reverse(); // 新→旧
  const today = new Date().toLocaleDateString('sv-SE'); // yyyy-mm-dd，跟机器人同一时区口径
  const todayRows = rows.filter((r) => {
    try { return new Date(r.at).toLocaleDateString('sv-SE') === today; } catch { return false; }
  });
  const gaps = rows.map((r) => Number(r.gapMin) || 0);
  return {
    ok: true,
    file: path.relative(ROOT, BOOT_LOG),
    exists: rows.length > 0,
    total: rows.length,
    todayCount: todayRows.length,
    maxGapMin: gaps.length ? Math.max(...gaps) : 0,
    // 「今天最长断了多久」比「一共断过几次」更接近主人真正想知道的
    todayMaxGapMin: todayRows.length ? Math.max(...todayRows.map((r) => Number(r.gapMin) || 0)) : 0,
    coldBoots: rows.filter((r) => r.tier === 'coldBoot').length,
    rows: all,
  };
}

// ---------- 设置菜单（2026-10-27 主人拍的 D 档）----------
// 为什么要它：她的功能开关原来全散在 config.json 里，改一个要开文本编辑器、还要记得重启。
// 面板上能看能点，就不用记键名了。
//
// **三条硬约束**（这是这套设计的前提，改动前先读）：
// ① 配置**不热读**：`bot/whale-bot.mjs` 的 CFG 是模块加载时从 config.json 构建一次的 const，
//    运行期不重读。所以这里写完 config.json 只是「存下来了」，要重启才生效。
//    → 因此有 `pendingSettings()`：记下「哪些键在机器人起来之后被改过」，面板顶部提示他重启。
// ② config.json 里有 `models[].apiKey` 真密钥。**绝不能做整份 JSON 编辑器**，
//    只认下面 SETTINGS_SCHEMA 里白名单列出的键，别的一律拒绝。
// ③ 只放**纯开关和纯数值**。数组类（白名单/名字/屏蔽名单）要专门的列表编辑器，那是第二批。
const SETTINGS_FILE = path.join(ROOT, 'config.json');
const SETTINGS_PENDING = path.join(ROOT, 'home', 'state', 'settings-pending.json');

// 每一项：key（config.json 里的点路径）/ label / desc（写清「关掉会怎样」）/ type / def / min / max / unit
const SETTINGS_SCHEMA = [
  {
    id: 'memory',
    title: '记忆与检索',
    hint: '管她「能想起多少旧事」。全关她也能聊天，只是会忘得很快。',
    items: [
      { key: 'bot.memoryOpen', label: '记忆打通', type: 'bool', def: true,
        desc: '开：群聊里也能想起私聊和别的群的事（但只对主人说具体内容）。关：各看各的。' },
      { key: 'bot.vectorMemory', label: '向量记忆', type: 'bool', def: true,
        desc: '开：按意思找旧事（要显存）。关：只按词面翻。' },
      { key: 'bot.vectorKeywordFallback', label: '向量没够分时补词面', type: 'bool', def: true,
        desc: '不花钱不占显存，建议开着。' },
      { key: 'bot.vectorTopK', label: '向量取几条', type: 'num', def: 3, min: 1, max: 10, unit: '条',
        desc: '每轮最多捞几条旧事进提示词。多了费 token。' },
      { key: 'bot.vectorMinScore', label: '向量最低分', type: 'num', def: 0.5, min: 0, max: 1, step: 0.01,
        desc: '低于这个相似度就不算「想起」。调低会捞进更多不相干的。' },
      { key: 'bot.rawTailMsgs', label: '私聊带多少句原话', type: 'num', def: 20, min: 2, max: 60, unit: '句',
        desc: '每轮提示词里附多少句最近的原话。少了接不上话，多了费 token。' },
      { key: 'bot.groupRawTailMsgs', label: '群聊带多少句原话', type: 'num', def: 20, min: 2, max: 60, unit: '句',
        desc: '同上，群里的。' },
      { key: 'bot.summaryEveryMsgs', label: '攒多少句压一次当天小结', type: 'num', def: 20, min: 5, max: 100, unit: '句',
        desc: '越小记得越细、越费钱。' },
      { key: 'bot.dreamEnabled', label: '做梦', type: 'bool', def: true,
        desc: '夜里一次，写独立文件不进主库。成本很低。' },
      { key: 'bot.profileBatchSize', label: '画像一批问几个人', type: 'num', def: 6, min: 1, max: 30, unit: '人',
        desc: '一次丢给模型的人数。太大容易漏人或写串（一晚三十几个人、两万多字那次的教训）。' },
    ],
  },
  {
    id: 'talk',
    title: '说话与回复',
    hint: '管她「怎么说话、什么时候先应答」。',
    items: [
      { key: 'bot.stripTailPeriod', label: '掐掉句末句号', type: 'bool', def: true,
        desc: 'QQ 上没人每句都打句号。关了就退回「全靠模型自觉」。' },
      { key: 'bot.fishWarn', label: '鱼味警告（只记日志）', type: 'bool', def: true,
        desc: '判出 AI 腔只记日志、不改她的话。成本约等于零，建议开。' },
      { key: 'bot.fishRewrite', label: '鱼味自动重写', type: 'bool', def: false,
        desc: '判出 AI 腔后真的改写她要说的话。默认关——先看效果再开。' },
      { key: 'bot.parallelChat', label: '私聊长活不让路', type: 'bool', def: true,
        desc: '开：她正在跑长活时，新消息另开一条车道先答。关：所有私聊排一条队（会等十几分钟）。' },
      { key: 'bot.busyAck', label: '忙时先回一句', type: 'bool', def: true,
        desc: '开：她忙的时候先说「我看到了，等下细说」。关：什么都不说，等他等。' },
      { key: 'bot.chatMergeMax', label: '积压消息合并上限', type: 'num', def: 8, min: 1, max: 20, unit: '条',
        desc: '他连发好几条时，一次最多合并成一轮。写 1 = 不合并。' },
      { key: 'bot.chatParallelGraceMs', label: '另开车道前等多久', type: 'num', def: 60000, min: 1000, max: 300000, unit: '毫秒',
        desc: '给「马上就结束的那一轮」一个收尾机会，太急会白多跑一轮。2026-10-27 从 30 秒提到 60 秒（35 秒这个空档里 98.8% 的消息其实不用另开）。' },
      { key: 'bot.busyAckCooldownMs', label: '「先回一句」冷却', type: 'num', def: 300000, min: 10000, max: 3600000, unit: '毫秒',
        desc: '同一次忙里只咳一声，别每来一条都说一遍。' },
      { key: 'bot.longBubble', label: '单条气泡最长多少字', type: 'num', def: 150, min: 30, max: 600, unit: '字',
        desc: '超过就在逗号处切开（只动本来就太长的那 13%）。改小她一句话会拆成更多条。' },
      { key: 'bot.quoteGapMsgs', label: '隔几条才带引用', type: 'num', def: 3, min: 0, max: 30, unit: '条',
        desc: '中间隔了这么多条就带引用框。写 0 = 紧挨着也引用（会很吵）。' },
      { key: 'bot.quoteGapMs', label: '隔多久才带引用', type: 'num', def: 120000, min: 0, max: 1800000, unit: '毫秒',
        desc: '或者隔了这么久就带引用。两个条件满足一个就引用。' },
    ],
  },
  {
    id: 'voice',
    title: '语音与表情',
    hint: '她发不发语音、发多少张表情。',
    items: [
      { key: 'bot.voiceEnabled', label: '语音', type: 'bool', def: false,
        desc: '开：她偶尔会发语音（要 CosyVoice3 装好）。关：只打字。' },
      { key: 'bot.voiceDailyLimit', label: '语音日上限', type: 'num', def: 80, min: 0, max: 500, unit: '条',
        desc: '一天最多几条语音。写 0 = 不发。' },
      { key: 'bot.voiceInMaxSeconds', label: '收到的语音转写上限', type: 'num', def: 90, min: 10, max: 600, unit: '秒',
        desc: '超过这个长度的语音她不转写。' },
      { key: 'bot.maxStickersPerReply', label: '一次最多几张表情', type: 'num', def: 2, min: 0, max: 6, unit: '张',
        desc: '和正图分开计数。写 0 = 不发表情包。' },
      { key: 'bot.syncFavorites', label: '同步 QQ 收藏表情', type: 'bool', def: true,
        desc: '只读不写，一天一次，成本约等于零。' },
      { key: 'bot.syncFavoritesEveryMs', label: '隔多久同步一次收藏', type: 'num', def: 86400000, min: 3600000, max: 604800000, unit: '毫秒',
        desc: '一天 = 86400000。改小能更快看到她新收的表情，但每轮都要读 QQ 云端列表。' },
      { key: 'bot.maxFavUploadPerDay', label: '往收藏夹写几张/天', type: 'num', def: 3, min: 0, max: 20, unit: '张',
        desc: '写的是你 QQ 账号的云端收藏（手机端可见）。写 0 = 完全不许写。' },
      { key: 'bot.voiceMaxPerReply', label: '一次回复最多几段语音', type: 'num', def: 2, min: 0, max: 6, unit: '段',
        desc: '超过的语音段会退化成文字发出去。写 0 = 不摘语音（等于关掉语音）。' },
    ],
  },
  {
    id: 'group',
    title: '群聊',
    hint: '管她在群里「说不说、说多快、说几句」。',
    items: [
      { key: 'group.enabled', label: '群聊总开关', type: 'bool', def: true,
        desc: '关：群里完全不理，只收私聊。' },
      { key: 'group.speakGapMs', label: '群内开口间隔', type: 'num', def: 30000, min: 5000, max: 600000, unit: '毫秒',
        desc: '半分钟才开口一次。窗口里的话先攒着，到点合成一轮。' },
      { key: 'group.maxBubbles', label: '一次最多几句', type: 'num', def: 3, min: 1, max: 10, unit: '句',
        desc: '群里一次最多分几条气泡。' },
    ],
  },
  {
    id: 'life',
    title: '她自己的生活',
    hint: '她晚上给自己找事、写日记复盘那几条线。关掉不影响聊天。',
    items: [
      { key: 'bot.newsEnabled', label: '晚上读新闻', type: 'bool', def: true,
        desc: '开：晚上给自己找事时抓几条当天标题（落盘到 home\\news\\），读完写感想。关：不联网不落盘，只写自己的想法。' },
      { key: 'bot.dailySummarySend', label: '每日小结（晚上发那句）', type: 'bool', def: true,
        desc: '关掉只是不把「今天收个尾、最实在的一件是…」发出来；复盘照写进文件，晚上照发一句晚安。' },
      { key: 'bot.firstWakeWindowMin', label: '首启问候窗口', type: 'num', def: 10, min: 1, max: 120, unit: '分钟',
        desc: '启动后这么多分钟内才认「今天第一次起来」并问候，过了就算错过、不补（防止每次重启都问一遍）。' },
      { key: 'bot.dreamKeepDays', label: '梦留几天还主动提', type: 'num', def: 30, min: 0, max: 365, unit: '天',
        desc: '超过这么多天的梦只在查历史时给，不再主动提。' },
      { key: 'bot.cardMaxPerDay', label: '每天最多记几张事件卡', type: 'num', def: 80, min: 0, max: 500, unit: '张',
        desc: '纯闲聊、表情包不写卡，所以正常达不到这个上限。写 0 = 当天不再记卡。' },
      { key: 'bot.overlayMaxPerKind', label: '演化每条线最多留几条', type: 'num', def: 8, min: 1, max: 50, unit: '条',
        desc: '她写 [演化:character|…] 那种自省，每类最多留几条，多的按时间淘汰。' },
      { key: 'bot.overlayInjectPerKind', label: '演化每轮注入几条', type: 'num', def: 2, min: 0, max: 10, unit: '条',
        desc: '每类每轮最多往回灌几条。多了占提示词。写 0 = 不注入（她写了也不影响说话）。' },
    ],
  },
  {
    id: 'cost',
    title: '预算与兜底',
    hint: '管她「一轮最多花多少、主模型挂了要不要花钱兜底」。',
    items: [
      { key: 'bot.maxSteps', label: '单轮最多几步', type: 'num', def: 40, min: 0, max: 200, unit: '步',
        desc: '写 0 = 不限（主人 2026-10-24 明确要的）。' },
      { key: 'bot.chatLaneMaxTokens', label: '对话车道 token 上限', type: 'num', def: 120000, min: 0, max: 5000000, unit: 'token',
        desc: '先答一句那条车道的天花板，防止两条线同时跑长活。写 0 = 不限。2026-10-27 从 40 万收到 12 万。' },
      { key: 'bot.chatLaneMaxSteps', label: '对话车道最多几步', type: 'num', def: 8, min: 0, max: 40, unit: '步',
        desc: '车道轮 6–8 步就该把一句答话说完。写 0 = 不限。（光压 token 等于「烧到上限才掐」，前面那截钱照花。）' },
      { key: 'bot.chatLaneNoTools', label: '对话车道不许查东西', type: 'bool', def: true,
        desc: '开：车道轮一调工具就掐掉、交回主车道（主车道本来就在干同一件事）。关：允许它自己查。' },
      { key: 'bot.longTailTokens', label: '长尾警戒线', type: 'num', def: 2000000, min: 0, max: 20000000, unit: 'token',
        desc: '单轮越线只记日志 + 打标记，**不拦截**。' },
      { key: 'bot.maxTokensPerTurn', label: '单轮 token 硬上限', type: 'num', def: 3000000, min: 0, max: 20000000, unit: 'token',
        desc: '真会拦断的那条线（和上面「只记账」的警戒线不同）。写 0 = 不限。' },
      { key: 'bot.autoFallback', label: '主模型挂了自动退官方', type: 'bool', def: false,
        desc: '开：免费模型挂了自动花钱兜底。关：挂了就是挂了（2026-10-23 主人关的，因为一天打了 221 次官方请求）。' },
    ],
  },
];

/** 点路径读写：'bot.vectorTopK' → cfg.bot.vectorTopK */
function cfgGet(obj, key) {
  let cur = obj;
  for (const seg of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}
function cfgSet(obj, key, val) {
  const segs = key.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = val;
}

/** 机器人这一版是什么时候起来的（boot.json 的 startAt，机器人自己写的，比 bot.pid 的 mtime 准）。 */
function botStartedAt() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'home', 'state', 'boot.json'), 'utf8'));
    return Number(b.startAt) || 0;
  } catch { return 0; }
}

/**
 * 在机器人起来之后被改过、但还没生效的键。
 * 记录形状：`{items:{key:{at,from}}}` —— 每条记「什么时候改的、改之前是什么」。
 * 记 `from` 是为了处理「改了又改回去」：最终值跟启动时一样，就不该再算待生效。
 */
function pendingSettings() {
  const started = botStartedAt();
  const empty = { count: 0, keys: [] };
  if (!started || !alive(readPid('bot.pid'))) return empty;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(SETTINGS_PENDING, 'utf8')); } catch { return empty; }
  const items = rec && typeof rec.items === 'object' && rec.items ? rec.items : null;
  if (!items) return empty;
  const keys = Object.keys(items).filter((k) => Number(items[k]?.at) > started);
  return { count: keys.length, keys };
}

/** 读当前 pending 记录（内部用，不判机器人活没活）。 */
function readPendingRecord() {
  try {
    const r = JSON.parse(fs.readFileSync(SETTINGS_PENDING, 'utf8'));
    if (r && typeof r.items === 'object' && r.items) return r;
  } catch { /* 没记录 */ }
  return { items: {} };
}

/** GET /api/settings：schema + 当前值 + 待生效。 */
function readSettings() {
  const cfg = loadConfig();
  if (!cfg) return { ok: false, msg: '读不到 config.json（设置向导还没跑过？）' };
  const groups = SETTINGS_SCHEMA.map((g) => ({
    id: g.id,
    title: g.title,
    hint: g.hint,
    items: g.items.map((it) => {
      const raw = cfgGet(cfg, it.key);
      const def = it.def;
      const cur = it.type === 'bool'
        ? (raw === undefined ? def : raw === true)
        : (Number.isFinite(Number(raw)) && raw !== null && raw !== '' ? Number(raw) : def);
      return { ...it, cur };
    }),
  }));
  return { ok: true, groups, pending: pendingSettings(), botStartedAt: botStartedAt() };
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
    // 概览页那一小条「今天断过几次」（2026-10-26）：整页在「重启」页看，这里只给两个数，
    // 免得他每次都要点进去才知道今天稳不稳。
    boot: (() => {
      const b = bootHistory(1);
      return { todayCount: b.todayCount, todayMaxGapMin: b.todayMaxGapMin, total: b.total, exists: b.exists };
    })(),
    // 设置菜单里改过、但机器人还没重启所以没生效的项（2026-10-27 D 档）。
    // 放在 /api/status 里，前端那个 3 秒轮询顺手就能把顶部提示刷新掉，不用另开一个定时器。
    pendingSettings: pendingSettings(),
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

// ---------- 车道成本（2026-10-26 主人选的 C 项） ----------
// 为什么要这一块：双车道上线后实测「对话车道一轮 4 步吃 238,439 token」「长活 21 步 849,714」，
// 而平时一轮才 2–3 万。这些东西只有事后 grep turns.jsonl 才看得见，等于管不住。
// 这里把「今天开了几次车道、各吃了多少、新增占多少」直接摆在面板上。
//
// ⚠️ 三个口径必须一次说清，否则看到的数字会骗人：
//   ① `total` **已含 cache**（实测 input+output+cache == total），所以「新增」= input+output；
//   ② cache 单价约为新增的 1/10，**别把 total 当钱**——`新增占比` 才是判断「贵不贵」的关键；
//   ③ `steps` 是成本的第一乘数（41 步那轮单轮吃 2.02M），所以要显示平均步数。
function laneCost({ days = 7 } = {}) {
  const since = Date.now() - Math.max(1, days) * 86400000;
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(LOGS, 'turns.jsonl'), 'utf8').trim().split('\n');
  } catch {
    return { ok: true, exists: false, days };
  }
  const rows = [];
  for (const l of lines.slice(-20000)) {
    try {
      const o = JSON.parse(l);
      if (o.ts >= since) rows.push(o);
    } catch { /* 坏行跳过 */ }
  }
  // 只看「跑过模型的轮」（tokens.total > 0）；被掐断的 0 token 轮也留在 items 里但不算进均价
  const withLane = rows.filter((r) => r.lane);
  const chatLane = rows.filter((r) => r.lane && String(r.lane).endsWith(':chat'));
  const taskLane = rows.filter((r) => r.lane && String(r.lane).endsWith(':task'));
  const main = rows.filter((r) => !r.lane);

  const sum = (arr, f) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);
  const stats = (arr) => {
    const paid = arr.filter((r) => Number(r.tokens && r.tokens.total) > 0);
    const total = sum(paid, (r) => r.tokens.total);
    const fresh = sum(paid, (r) => (r.tokens.input || 0) + (r.tokens.output || 0));
    const steps = sum(paid, (r) => r.steps);
    return {
      count: arr.length,
      paidTurns: paid.length,
      total,
      fresh,
      cache: sum(paid, (r) => r.tokens.cache),
      steps,
      avgTotal: paid.length ? Math.round(total / paid.length) : 0,
      avgSteps: paid.length ? +(steps / paid.length).toFixed(1) : 0,
      avgPerStep: steps ? Math.round(total / steps) : 0,
      freshPct: total ? +((fresh / total) * 100).toFixed(1) : 0,
      maxTotal: paid.length ? Math.max(...paid.map((r) => Number(r.tokens.total) || 0)) : 0,
      maxSteps: paid.length ? Math.max(...paid.map((r) => Number(r.steps) || 0)) : 0,
    };
  };

  // 按天分桶（北京时间 + 凌晨四点线，与机器人 logicalDay 一致）
  const dayOf = (ts) => {
    const d = new Date(ts + 8 * 3600 * 1000 - 4 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };
  const dayMap = new Map();
  for (const r of rows) {
    const day = dayOf(r.ts);
    const b = dayMap.get(day) || { day, chat: 0, chatTokens: 0, task: 0, taskTokens: 0, mainTokens: 0 };
    const tk = Number(r.tokens && r.tokens.total) || 0;
    if (r.lane && String(r.lane).endsWith(':chat')) {
      b.chat += 1;
      b.chatTokens += tk;
    } else if (r.lane) {
      b.task += 1;
      b.taskTokens += tk;
    } else b.mainTokens += tk;
    dayMap.set(day, b);
  }
  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  return {
    ok: true,
    exists: true,
    days,
    now: Date.now(),
    main: stats(main),
    chat: stats(chatLane),
    task: stats(taskLane),
    byDay,
    // 明细：只给最近车道轮次（最多 40），让人能点开看具体哪一轮贵
    items: withLane
      .filter((r) => String(r.lane).endsWith(':chat'))
      .slice(-40)
      .reverse()
      .map((r) => ({
        ts: r.ts,
        ok: r.ok,
        ms: r.ms,
        steps: r.steps || 0,
        total: Number(r.tokens && r.tokens.total) || 0,
        fresh: (r.tokens && (r.tokens.input || 0) + (r.tokens.output || 0)) || 0,
        cache: Number(r.tokens && r.tokens.cache) || 0,
        chars: r.chars || 0,
        reason: r.reason || '',
        budget: r.budget || null,
      })),
  };
}

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
    // 她「选择不回」的账本（2026-10-26）：?days=7 看几天内，?limit= 限制条数
    if (url.pathname === '/api/skips') {
      return json(
        res,
        200,
        skipData({
          days: Number(url.searchParams.get('days')) || 7,
          limit: Number(url.searchParams.get('limit')) || 300,
        }),
      );
    }
    // 车道成本（2026-10-26）：主车道 / 对话车道 / 内部任务各花了多少，新增占比多少
    if (url.pathname === '/api/lanecost') {
      return json(res, 200, laneCost({ days: Number(url.searchParams.get('days')) || 7 }));
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
    if (url.pathname === '/api/boots') return json(res, 200, bootHistory(Number(url.searchParams.get('limit')) || 60));
    // ---- 设置菜单（2026-10-27 D 档）----
    if (url.pathname === '/api/settings' && req.method !== 'POST') return json(res, 200, readSettings());
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      const patch = b && typeof b === 'object' ? (b.patch || {}) : {};
      // 白名单：只认 schema 里出现过的键。config.json 里有真密钥，绝不做整份编辑器。
      const allowed = new Map();
      for (const g of SETTINGS_SCHEMA) for (const it of g.items) allowed.set(it.key, it);
      const cfg = loadConfig();
      if (!cfg) return json(res, 500, { ok: false, msg: '读不到 config.json' });
      const changed = [];
      const bad = [];
      // 改之前的原值（记进 pending 的 from，用来处理「改了又改回去」）
      const before = new Map();
      for (const [k, v] of Object.entries(patch)) {
        const it = allowed.get(k);
        if (!it) { bad.push(`${k}（不在白名单里）`); continue; }
        const prev = cfgGet(cfg, k);
        if (it.type === 'bool') {
          const nv = v === true || v === 'true' || v === 1 || v === '1';
          if (prev === nv) continue;
          before.set(k, prev === undefined ? it.def : prev === true);
          cfgSet(cfg, k, nv);
          changed.push(k);
        } else {
          const n = Number(v);
          if (!Number.isFinite(n)) { bad.push(`${k}（不是数字）`); continue; }
          const lo = it.min ?? -Infinity;
          const hi = it.max ?? Infinity;
          const clamped = Math.min(hi, Math.max(lo, n));
          if (Number(prev) === clamped) continue;
          before.set(k, Number.isFinite(Number(prev)) && prev !== null && prev !== '' ? Number(prev) : it.def);
          cfgSet(cfg, k, clamped);
          changed.push(k);
        }
      }
      if (!changed.length) {
        return json(res, 200, { ok: true, changed: [], bad, pending: pendingSettings(), msg: bad.length ? `有几项没认：${bad.join('、')}` : '没有变化' });
      }
      saveConfig(cfg);
      // 记一笔「哪些键在机器人起来之后被改过」——面板顶部靠它算「有几项待生效」。
      // 每条记 `{at, from}`：`from` 是**机器人启动时那个值**（不是上一次改之前的值）。
      // 为什么：改了又改回去 = 跟启动时一样 = 不该再算待生效，所以要跟 from 比。
      try {
        const rec = readPendingRecord();
        const now = Date.now();
        for (const k of changed) {
          const prevRec = rec.items[k];
          // 已经有记录就沿用它的 from（那才是启动时的值）；没有就把这次的原值当 from
          const from = prevRec && 'from' in prevRec ? prevRec.from : before.get(k);
          const nowVal = cfgGet(cfg, k);
          if (nowVal === from) delete rec.items[k]; // 改回原样了，不算待生效
          else rec.items[k] = { at: now, from };
        }
        fs.mkdirSync(path.dirname(SETTINGS_PENDING), { recursive: true });
        fs.writeFileSync(SETTINGS_PENDING, JSON.stringify(rec, null, 2) + '\n', 'utf8');
      } catch { /* 记不上不影响配置已经存好 */ }
      const pend = pendingSettings();
      return json(res, 200, {
        ok: true,
        changed,
        bad,
        pending: pend,
        // 只写 config.json，不自动重启：她可能正在跑一轮，打断比多等几秒更糟（D 档的核心取舍）
        msg: `存好了 ${changed.length} 项。${pend.count ? `还有 ${pend.count} 项要重启才生效。` : ''}`,
      });
    }
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
