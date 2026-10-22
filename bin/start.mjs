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
};

// ---- 自改护栏 ----
// 机器人自己（或你）改了代码之后，看门人负责三道闸：
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

function syntaxError(file) {
  const r = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.status === 0) return null;
  const txt = String(r.stderr || r.stdout || '').trim();
  return txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' | ') || `node --check 退出码 ${r.status}`;
}

function guard() {
  if (stopping) return;
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // 不是 git 仓就当没这回事
  const broken = [];
  for (const f of mjsFiles()) {
    const err = syntaxError(f);
    if (err) broken.push({ f, err });
  }
  if (broken.length) {
    const dir = path.join(BROKEN_DIR, stamp());
    fs.mkdirSync(dir, { recursive: true });
    for (const { f, err } of broken) {
      const rel = path.relative(ROOT, f);
      try { fs.copyFileSync(f, path.join(dir, path.basename(f))); } catch { /* 存不下也先把树还原 */ }
      const tracked = git(['ls-files', '--error-unmatch', rel]).status === 0;
      if (tracked) {
        git(['checkout', 'HEAD', '--', rel]);
        say(`语法匣：${rel} 有错（${err}），已从上一个提交还原；坏的那份留在 ${path.relative(ROOT, dir)}`);
      } else {
        fs.rmSync(f, { force: true });
        say(`语法匣：${rel} 有错（${err}），这是新加的没提交过，已挪走；坏的那份留在 ${path.relative(ROOT, dir)}`);
      }
    }
  }
  const st = git(['status', '--porcelain']);
  const dirty = String(st.stdout || '').trim();
  if (st.status === 0 && dirty) {
    const names = dirty.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean);
    const brief = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 个文件` : '');
    git(['add', '-A']);
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
    hint: `连续 ${fails} 次起来就退，看门人停手了。把最后一次改动改回去，或到面板点「启动」重来。`,
  };
  try { fs.writeFileSync(HALT_FILE, JSON.stringify(info, null, 2) + '\n', 'utf8'); } catch { /* 写不下也照样停手 */ }
}

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// 同一个包只跑一个看门人
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

// 后台模式：输出进文件
let outFd = null;
if (DETACH) {
  outFd = fs.openSync(path.join(LOGS, 'supervisor.log'), 'a');
}

function launch() {
  if (stopping) return;
  try { guard(); } catch (e) { say(`护栏自己出错了（${e.message}），跳过，照常启动`); }
  const stdio = DETACH ? ['ignore', outFd, outFd] : 'inherit';
  child = spawn(process.execPath, [path.join(ROOT, 'bot', 'whale-bot.mjs')], {
    cwd: ROOT,
    stdio,
    windowsHide: !DETACH,
    env: { ...process.env },
  });
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
