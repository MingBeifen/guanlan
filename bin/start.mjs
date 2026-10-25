// 看门人：拉机器人，挂了就五秒后重拉。面板的「启动/停止/重启」也是走这里。
// 用法：node bin\start.mjs          前台（黑窗口里看得到日志）
//       node bin\start.mjs --detach 后台（面板用，日志写 logs\supervisor.log）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETACH = process.argv.includes('--detach');
const RUNTIME = path.join(ROOT, 'runtime');
const LOGS = path.join(ROOT, 'logs');
const PID_FILE = path.join(RUNTIME, 'supervisor.pid');
const BOT_PID_FILE = path.join(RUNTIME, 'bot.pid');
fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const say = (s) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
  // 2026-10-23：后台模式下看门人自己的话（护栏、重拉、停手）原来只走它自己的 stdout，
  // 而面板是用 stdio:'ignore' 把它拉起来的，那些话等于全丢了；补一份进 supervisor.log，
  // 不然改动到底验没验过、提交没有，日志里一点痕迹都没有。
  if (DETACH) {
    try { fs.appendFileSync(path.join(LOGS, 'supervisor.log'), line + '\n'); } catch { /* 写不下就算了 */ }
  }
};

// ---- 自改护栏 ----
// 她（或主人）改了代码之后，看门人负责三道闸：
//   1) 语法匣：所有 .mjs 先过 node --check；坏的那份留档到 runtime\broken\<时间>\，再从上一个提交还原
//   2) 留痕：验过的改动自动 commit，每次启动都是一个能回滚到的点
//   3) 退避：起来就退不无限重拉，连续 5 次就停手，理由写 runtime\supervisor-halt.json
const HALT_FILE = path.join(RUNTIME, 'supervisor-halt.json');
const BROKEN_DIR = path.join(RUNTIME, 'broken');
const SCAN_DIRS = ['bot', 'panel', 'bin', path.join('home', 'tools'), path.join('home', 'memory')];
const BACKOFF = [5000, 15000, 60000, 300000];
const MAX_FAILS = 5;

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });

// ---------- 提交前的「不该进仓」拦截（2026-10-25 加） ----------
// 为什么要有：看门人的自改留痕是 `git add -A`，它不挑食。2026-10-25 凌晨就发生了两次：
// `6eece2f` 把另一个会话正在跑的 `home/tmp/cdp-profile-*`（2832 个文件，含
// `Default/Network/Cookies` 20KB、`Login Data` 51KB、`Web Data` 235KB）一起提交并推送。
// `.gitignore` 事后补了 `home/tmp/`，但**不能只靠 .gitignore**——它可能被误删/被改动，
// 而且历史里已经躺着的那些它管不着。所以这里在 add 之前再做一道代码级过滤：
// 命中就**整个文件从本批剔除**（`git reset` 回未暂存），并把名字打进日志。
// 判据只针对「用户数据/凭据/临时产物」，不碰源码——宁可漏挡，不能把她正常的改动挡掉。
const ADD_BLOCKLIST = [
  /(^|\/)home[\\/]tmp[\\/]/i, // 临时目录：浏览器 profile、截图中间产物
  /(^|\/)cdp-profile-[^\\/]*/i, // Chrome/Edge 自动化 profile 本体
  /(^|\/)(Cookies|Login Data|Web Data|Local State|Preferences)$/i,
  /(^|\/)(Local Storage|Session Storage|IndexedDB|Service Worker|Trust Tokens|ClientCertificates)[\\/]/i,
  /(^|\/)\.credentials\.yaml$/i,
  /(^|\/)node_modules[\\/]/i,
  /\.(db|sqlite|sqlite3)$/i,
];
const blockReason = (rel) => (ADD_BLOCKLIST.some((re) => re.test(rel)) ? "用户数据/凭据/临时产物" : "");

// 把命中的文件从暂存区撤下来。返回被撤下的路径数组（空数组 = 这批是干净的）。
function unstageRisky(rels) {
  const risky = rels.filter((r) => blockReason(r));
  if (!risky.length) return [];
  // 逐个 reset 而不是 reset -- <全部>：单个失败不影响其它，且能精确记名字
  for (const r of risky) {
    const rs = git(['reset', '-q', 'HEAD', '--', r]);
    // 还没有 HEAD（首次提交前）时 reset HEAD 会失败，退化成 rm --cached
    if (rs.status !== 0) git(['rm', '--cached', '-q', '--', r]);
  }
  return risky;
}

function mjsFiles() {
  const out = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isFile() && e.name.endsWith('.mjs')) out.push(path.join(abs, e.name));
  }
  return out;
}

// 注意：「检查自己没跑起来」和「语法真的错」是两码事。2026-10-23 踩到的坑：
// spawnSync 失败时 status 是 null，老代码把它当成每个文件都坏了，又因为 git 查不到记录，
// 结果把 bot/panel/bin 里所有 .mjs 全删空，机器人起不来。跑不起来的检查一律不动文件。
function syntaxError(file) {
  const r = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error || r.status === null) {
    const why = r.error?.code || r.error?.message || '被掐掉了';
    return { skip: true, err: `检查没能跑起来（${why}），这个文件没动` };
  }
  if (r.status === 0) return null;
  // node --check 只在对语法报错时返回 1。别的非零码是检查本身出了问题
  // （参数不对、文件读不到、被拦），不能当成语法错去还原或删文件。
  if (r.status !== 1) {
    return { skip: true, err: `检查没能跑起来（退出码 ${r.status}），这个文件没动` };
  }
  const txt = String(r.stderr || r.stdout || '').trim();
  const msg = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' | ') || `node --check 退出码 ${r.status}`;
  return { skip: false, err: msg };
}

function guard() {
  if (stopping) return;
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // 不是 git 仓就当没这回事
  const broken = [];
  for (const f of mjsFiles()) {
    const got = syntaxError(f);
    if (!got) continue;
    if (got.skip) { say(`语法匣：${path.relative(ROOT, f)} ${got.err}`); continue; }
    broken.push({ f, err: got.err });
  }
  if (broken.length) {
    const dir = path.join(BROKEN_DIR, stamp());
    fs.mkdirSync(dir, { recursive: true });
    // 先存好备份再动树；哪个存不下，那个就原样留着——宁可不修，不能删了没处找
    const saved = new Map();
    for (const { f } of broken) {
      try {
        fs.copyFileSync(f, path.join(dir, path.basename(f)));
        saved.set(f, true);
      } catch (e) {
        saved.set(f, false);
        say(`语法匣：${path.relative(ROOT, f)} 的备份没存下去（${e.code || e.message}），这个文件不动`);
      }
    }
    for (const { f, err } of broken) {
      const rel = path.relative(ROOT, f);
      const kept = `坏的那份留在 ${path.relative(ROOT, dir)}`;
      if (!saved.get(f)) continue; // 上面已经说过
      const ls = git(['ls-files', '--error-unmatch', rel]);
      // 0 = 在库里，1 = 新加的还没提交过，其它（含 spawn 失败）一律当查不清，别动
      if (ls.error || ls.status === null || (ls.status !== 0 && ls.status !== 1)) {
        const why = ls.error?.code || `退出码 ${ls.status}`;
        say(`语法匣：${rel} 有错（${err}），但查不到 git 记录（${why}），先没动它；${kept}`);
        continue;
      }
      if (ls.status === 0) {
        const co = git(['checkout', 'HEAD', '--', rel]);
        if (co.status === 0) say(`语法匣：${rel} 有错（${err}），已从上一个提交还原；${kept}`);
        else say(`语法匣：${rel} 有错（${err}），还原没成功（${String(co.stderr || '').trim().split(/\r?\n/)[0] || `退出码 ${co.status}`}），先没动它；${kept}`);
      } else {
        fs.rmSync(f, { force: true });
        say(`语法匣：${rel} 有错（${err}），这是新加的没提交过，已挪走；${kept}`);
      }
    }
  }
  const st = git(['status', '--porcelain']);
  if (st.error || st.status !== 0) {
    if (st.error || st.status !== null) say(`留痕：git status 没跑成（${st.error?.code || `退出码 ${st.status}`}），这次不提交`);
    return;
  }
  // ⚠️ 这里**不能**对 st.stdout 整体 trim：porcelain 第一行的首字符可能就是状态位前
  // 的空格（" M path"），trim 掉它会让后面 slice(3) 多切一个字符（曾把 bot/ 切成 ot/）。
  const dirty = String(st.stdout || '').replace(/\s+$/, '');
  if (dirty.trim()) {
    const names = dirty
      .split(/\r?\n/)
      .map((l) => {
        const code = l.slice(0, 2);
        if (!code.trim()) return '';
        return l.slice(3).trim() || l.slice(2).trim();
      })
      .filter(Boolean);
    const brief = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 个文件` : '');
    const add = git(['add', '-A']);
    if (add.status !== 0) {
      say(`留痕：git add 没跑成（${String(add.stderr || '').trim().split(/\r?\n/)[0] || `退出码 ${add.status}`}），改动还在，只是没提交`);
      return;
    }
    // 2026-10-25 加：add 之后、commit 之前，把不该进仓的东西撤下来。
    // 用 `git diff --cached --name-only` 拿真实暂存清单（比 names 准：names 来自
    // status 阶段，add 之后可能又变了），再逐个 reset。
    const staged = git(['diff', '--cached', '--name-only', '-z']);
    const stagedRels = String(staged.stdout || '')
      .split('\u0000')
      .map((s) => s.replace(/\s+$/, ''))
      .filter(Boolean);
    const risky = unstageRisky(stagedRels);
    if (risky.length) {
      // 不打全部名字（可能几千个），只报数量 + 前几个 + 落盘一份完整清单
      const head = risky.slice(0, 3).join('、');
      say(`留痕：拦下 ${risky.length} 个不该进仓的文件（${head}${risky.length > 3 ? ' 等' : ''}），已从这次提交里撤下`);
      try {
        fs.writeFileSync(
          path.join(RUNTIME, `blocked-commit-${stamp()}.txt`),
          risky.join('\n') + '\n',
          'utf8',
        );
      } catch { /* 记不下来也不影响拦截本身 */ }
      // 全被拦下时就没有可提交的东西了，别硬提交一个空改动
      if (risky.length >= stagedRels.length) {
        say('留痕：这批改动全是该拦的，这次不提交');
        return;
      }
    }
    const c = git(['commit', '-m', `自改 ${stamp()}：${brief}`]);
    if (c.status === 0) say(`留痕：动了 ${names.length} 个文件，已提交（${stamp()}）`);
    else say(`留痕没成功（${String(c.stderr || '').trim().split(/\r?\n/)[0]}），改动还在，只是没提交`);
  }
}

let fails = 0;
let launchedAt = 0;

function halt(code) {
  const info = {
    at: new Date().toISOString(),
    fails,
    code,
    hint: `连续 ${fails} 次起来就退，看门人停手了。把最后一次改动改回去，或在面板点「启动」重来。`,
  };
  try { fs.writeFileSync(HALT_FILE, JSON.stringify(info, null, 2) + '\n', 'utf8'); } catch { /* 写不下也照样停手 */ }
}

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// 拦截规则的自检用例（2026-10-25 加）——放在这里是为了让「手动跑」和「开机自动跑」
// 共用一个来源：两份清单一旦分叉，自动跑的那份就会悄悄少测几条。
// [路径, 应该被拦吗, 说明]
const BLOCKLIST_CASES = [
  ['home/tmp/cdp-profile-9705/Default/Network/Cookies', true, '真实泄漏路径'],
  ['home/tmp/cdp-profile-9705/Default/Login Data', true, '密码库'],
  ['home/tmp/cdp-profile-9705/Default/Web Data', true, '自动填充'],
  ['home/tmp/chrome-gh/Default/Code Cache/js/abc', true, 'chrome profile 缓存'],
  ['home/tmp/bal.mjs', true, '临时脚本'],
  ['home/tmp/anything/new.txt', true, 'tmp 下任何新东西'],
  ['bot/whale-bot.mjs', false, '源码必须放行'],
  ['bin/start.mjs', false, '源码必须放行'],
  ['home/memory/store.json', false, '记忆库要进仓'],
  ['panel/index.html', false, '面板要进仓'],
  ['home/voice/say-voice.py', false, '语音脚本要进仓'],
  ['config.example.json', false, '示例配置要进仓'],
  ['home/state/overlay.json', false, '状态文件按现有做法进仓'],
  ['node_modules/x/index.js', true, '依赖不该进仓'],
  ['home/memory/some.db', true, '数据库文件'],
  ['.credentials.yaml', true, '凭据文件名'],
];

/** 跑一遍拦截用例，返回不符的条数与明细。不打印、不退出——调用方自己决定怎么处置。 */
function runBlocklistCases() {
  const bad = [];
  for (const [rel, want, why] of BLOCKLIST_CASES) {
    const got = Boolean(blockReason(rel));
    if (got !== want) bad.push({ rel, want, got, why });
  }
  return bad;
}

// 同一个包只跑一个看门人
// 2026-10-25 补：纯自检开关（--blocklist-test）要在这道保护**之前**处理——
// 否则机器人正在跑的时候，自检会被「已经在跑了」挡掉、看起来像测试通过。
if (process.argv.includes('--blocklist-test')) {
  const bad = runBlocklistCases();
  for (const c of BLOCKLIST_CASES) {
    const got = Boolean(blockReason(c[0]));
    const ok = got === c[1];
    console.log(`${ok ? '对' : '错'}  ${c[1] ? '应拦' : '应放'} → ${got ? '拦下' : '放行'}  ${c[0]}  ${c[2]}`);
  }
  console.log(bad.length ? `\n${bad.length} 条不符` : '\n全部符合预期');
  process.exit(bad.length ? 1 : 0);
}

const old = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
if (old && old !== process.pid && alive(old)) {
  say(`已经在跑了（看门人 PID ${old}），不重复启动。`);
  process.exit(0);
}

const cfg = loadConfig();
if (!cfg) {
  console.error('没有 config.json，先跑「setting.bat」。');
  process.exit(1);
}
if (!cfg.bot?.owners?.[0]) {
  console.error('config.json 里 bot.owners 是空的，先在设置里填主人的 QQ 号。');
  process.exit(1);
}
if (!cfg.dsh?.exe || !fs.existsSync(cfg.dsh.exe)) {
  console.error('找不到 DeepSeek Harness.exe（config.json → dsh.exe）。先装桌面端，再跑一次设置。');
  process.exit(1);
}

fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
// 这次是人工/开机重来的，上一次的停手记录作废
fs.rmSync(HALT_FILE, { force: true });

let child = null;
let stopping = false;
const cleanup = () => {
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(BOT_PID_FILE, { force: true });
};
const stop = () => {
  stopping = true;
  if (child && !child.killed) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  }
  cleanup();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 后台模式：看门人自己的话进文件；**bot 的输出不再双写**。
// ⚠️ 2026-10-25 修（日志三件套之一）：原来 `stdio = ['ignore', outFd, outFd]` ——
// 把 bot 的 stdout 和 stderr **整份**接到 supervisor.log 的 fd 上，而 bot 的 log()
// 又自己 appendFileSync 写 whale-bot.log → **supervisor.log 里 98.9% 是 whale-bot.log 的副本**。
// 更糟的是那个 fd 是长期开着的：bot 里 rotateOneLog 对 supervisor.log 做 renameSync 只换目录项，
// fd 仍指向旧 inode → 改名后新内容全进旧卷、新名字的文件 0 字节、面板读它就是空白。
// 现在的分工：
//   · bot 的正常日志 → 它自己写 whale-bot.log（唯一真相）
//   · bot 的 **stderr** → 捕获下来带前缀追加进 supervisor.log（崩溃线索不能丢，
//     但量极小：实测正常跑时 stderr 基本是空的）
//   · 看门人自己的话 → say() 按路径 appendFileSync（每次重开，rotate 安全）
let outFd = null;
if (DETACH) {
  outFd = fs.openSync(path.join(LOGS, 'supervisor.log'), 'a');
}

// bot 的 stderr 逐行转进 supervisor.log，带 [BOT-ERR] 前缀，方便 grep 区分是谁说的。
function pipeBotStderr(child) {
  if (!DETACH || !child?.stderr) return;
  let buf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { fs.appendFileSync(path.join(LOGS, 'supervisor.log'), `[BOT-ERR] ${t}\n`); } catch { /* 写不下算了 */ }
    }
  });
}

function launch() {
  if (stopping) return;
  // 2026-10-25 加：每次拉起机器人前，先验一遍「提交拦截」规则还对不对。
  // 为什么挂在这：看门人每轮都会自己 `git add -A` 留痕，规则一旦被改坏（比如有人整理
  // ADD_BLOCKLIST 时误删一条），下一次留痕就会把凭据带进仓——那时候再发现已经晚了。
  // **只在有问题时出声**：16 条正则跑一遍是微秒级，成功时不该往日志里刷噪音。
  try {
    const badRules = runBlocklistCases();
    if (badRules.length) {
      const head = badRules.slice(0, 2).map((b) => b.rel).join('、');
      say(`⚠ 拦截规则自检没过：${badRules.length} 条不符（${head}${badRules.length > 2 ? ' 等' : ''}）。` +
        `下一次留痕可能把不该进仓的东西提交上去，查 ADD_BLOCKLIST`);
    }
  } catch (e) {
    say(`拦截规则自检自己出错了（${e.message}），这次跳过，留痕照常`);
  }
  try { guard(); } catch (e) { say(`护栏自己出错了（${e.message}），跳过，照常启动`); }
  // bot 的 stdout 丢弃（它自己写 whale-bot.log），stderr 用 'pipe' 单独收（见 pipeBotStderr）
  const stdio = DETACH ? ['ignore', 'ignore', 'pipe'] : 'inherit';
  child = spawn(process.execPath, [path.join(ROOT, 'bot', 'whale-bot.mjs')], {
    cwd: ROOT,
    stdio,
    windowsHide: !DETACH,
    env: { ...process.env },
  });
  if (DETACH) pipeBotStderr(child);
  if (child.pid) fs.writeFileSync(BOT_PID_FILE, String(child.pid), 'utf8');
  launchedAt = Date.now();
  say(`机器人起来了（PID ${child.pid}）`);
  child.on('exit', (code) => {
    fs.rmSync(BOT_PID_FILE, { force: true });
    if (stopping) return;
    const lived = Date.now() - launchedAt;
    // 撑过一分钟就算活过来了，计数清零；起来就退才累加
    if (lived > 60000) {
      if (fails) say('上一轮撑过一分钟，重拉计数清零');
      fails = 0;
      fs.rmSync(HALT_FILE, { force: true });
    }
    fails += 1;
    if (fails >= MAX_FAILS) {
      halt(code);
      say(`连续 ${fails} 次起来就退（最后一回只掁了 ${Math.round(lived / 1000)} 秒），停手了，不再重拉。`);
      say(`原因和恢复办法已写进 ${path.relative(ROOT, HALT_FILE)}`);
      cleanup();
      process.exit(1);
    }
    const wait = BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)];
    say(`机器人退出了（code ${code}），${Math.round(wait / 1000)} 秒后重拉（连续第 ${fails} 次）`);
    setTimeout(launch, wait);
  });
}

launch();

// ---- 面板：顺手拉起，但它是独立进程 ----
// 机器人重启/停止都不会带走面板；面板自己崩了，下次启动机器人就自愈。
// 端口已经在听就跳过（比如你双击了「openpanel.bat」）。拉起时不开浏览器，省得每次重启弹新标签。
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(400);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function ensurePanel() {
  const port = Number(process.env.PANEL_PORT || cfg.panel?.port) || 8790;
  if (await portOpen(port)) return;
  const fd = fs.openSync(path.join(LOGS, 'panel.log'), 'a');
  const p = spawn(process.execPath, [path.join(ROOT, 'panel', 'server.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, PANEL_NO_OPEN: '1' },
  });
  p.unref();
  say(`面板没在跑，顺手拉了一个（PID ${p.pid}）`);
}

ensurePanel().catch(() => { /* 面板拉不起来不影响机器人 */ });
