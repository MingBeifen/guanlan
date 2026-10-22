// 依赖自检 + 自动补齐。
// 双击「check-deps.bat」就是跑这个；命令行也行：
//   node bin\check-deps.mjs            交互：先列清单，再问你要补哪些
//   node bin\check-deps.mjs --check    只看，什么都不动（缺必需的会以退出码 1 结束）
//   node bin\check-deps.mjs --install  缺什么补什么，不问了
//   node bin\check-deps.mjs --only=model,transformers   只处理点名的那几项
//
// 每样东西都装回它该在的位置：
//   @huggingface/transformers -> home\memory\node_modules\
//   bge 模型                  -> home\models\bge-base-zh-v1.5\
//   edge-tts                  -> 当前这个 Python 的 site-packages
// 装不动的（Node 本体、ffmpeg、NapCat、DSH 桌面端）只报状态并给下载地址，不硬装。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, 'home');
const MEM_DIR = path.join(HOME, 'memory');
const MODEL_DIR = path.join(HOME, 'models', 'bge-base-zh-v1.5');
const TTY = Boolean(stdout.isTTY);
const C = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = C('2');
const bold = C('1');
const red = C('31');
const green = C('32');
const yellow = C('33');
const cyan = C('36');

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const MODE = argv.includes('--install')
  ? 'install'
  : argv.includes('--preflight')
    ? 'preflight'
    : argv.includes('--check')
      ? 'check'
      : 'ask';
// 启动前静默预检只关心「装没装」，不关心 NapCat 连没连上（那个可能是后开的）
const PREFLIGHT_IDS = ['node', 'config', 'dsh'];
const HF = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');
const MODEL_REPO = 'Xenova/bge-base-zh-v1.5';

const human = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const run = (exe, args, opts = {}) =>
  spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...opts });

// ---------- 检查项 ----------
// check() 返回 { ok, detail }；fix() 返回 Promise<boolean>；manual 是装不动时给的话。

const nodeVer = process.versions.node;
const nodeMajor = Number(nodeVer.split('.')[0]);

const items = [
  {
    id: 'node',
    title: 'Node.js 20 或更新',
    required: true,
    where: '系统 PATH',
    url: 'https://nodejs.org/zh-cn/download',
    note: '装 LTS 版，一路下一步。装完把窗口全关掉再双击这个脚本。',
    check() {
      const ok = nodeMajor >= 20;
      return { ok, detail: `v${nodeVer}` };
    },
    manual: '到 https://nodejs.org/ 下 LTS 版装上，装完关掉这个窗口重新双击。',
  },
  {
    id: 'dsh',
    title: 'DeepSeek Harness 桌面端',
    required: true,
    where: 'config.json → dsh.exe',
    url: 'https://github.com/deepseek-ai/DeepSeek-Harness/releases',
    missingLabel: '未配置',
    note: '装完能正常打开一次就行。然后双击 setting.bat 重填一次路径。',
    check() {
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* 还没配 */ }
      const exe = String(cfg?.dsh?.exe || '');
      const cli = String(cfg?.dsh?.cli || '');
      if (!exe) return { ok: false, detail: 'config.json 里还没填 dsh.exe（跑一次 setting.bat）' };
      if (!fs.existsSync(exe)) return { ok: false, detail: `填了但找不到：${exe}` };
      if (!cli || !fs.existsSync(cli)) return { ok: false, detail: 'exe 在，但 cli.js 没找到（版本不对？）' };
      return { ok: true, detail: exe };
    },
    manual: '桌面端要自己装，包不带你装。装完双击 setting.bat 重填一次路径。',
  },
  {
    id: 'transformers',
    title: '@huggingface/transformers（向量记忆用）',
    required: false,
    where: 'home\\memory\\node_modules\\',
    url: 'https://registry.npmmirror.com/package/@huggingface/transformers',
    note: '不装也能跑，只是按意思找旧事这块会跳过，退回关键词检索。',
    check() {
      const p = path.join(MEM_DIR, 'node_modules', '@huggingface', 'transformers');
      if (!fs.existsSync(p)) return { ok: false, detail: '没装（向量记忆会静默跳过，不影响回话）' };
      let v = '?';
      try { v = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version || '?'; } catch { /* ignore */ }
      return { ok: true, detail: `v${v}` };
    },
    async fix() {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const regs = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
      for (const reg of regs) {
        console.log(dim(`  npm install（registry=${reg}）…`));
        const args = fs.existsSync(npmCli)
          ? [npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${reg}`]
          : ['install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${reg}`];
        const exe = fs.existsSync(npmCli) ? process.execPath : 'npm.cmd';
        const r = await new Promise((resolve) => {
          const ch = spawn(exe, args, { cwd: MEM_DIR, stdio: 'inherit', windowsHide: true, shell: !fs.existsSync(npmCli) });
          ch.on('exit', (code) => resolve(code === 0));
          ch.on('error', () => resolve(false));
        });
        if (r && fs.existsSync(path.join(MEM_DIR, 'node_modules', '@huggingface', 'transformers'))) return true;
      }
      return false;
    },
    manual: '也可以在 home\\memory 里手动跑：npm install --registry=https://registry.npmmirror.com',
  },
  {
    id: 'model',
    title: 'bge-base-zh-v1.5 向量模型（约 389 MB）',
    required: false,
    where: 'home\\models\\bge-base-zh-v1.5\\',
    url: 'https://hf-mirror.com/Xenova/bge-base-zh-v1.5',
    note: '官方源在国内经常连不上，脚本走的是 hf-mirror 镜像。',
    check() {
      const must = [
        ['config.json', 938],
        ['tokenizer.json', 439124],
        ['tokenizer_config.json', 366],
        ['special_tokens_map.json', 125],
        ['onnx/model.onnx', 406953171],
      ];
      const missing = [];
      let have = 0;
      for (const [rel, size] of must) {
        const p = path.join(MODEL_DIR, rel);
        if (!fs.existsSync(p)) { missing.push(rel); continue; }
        const got = fs.statSync(p).size;
        have += got;
        if (got !== size) missing.push(`${rel}（大小不对 ${got}≠${size}，可能下了一半）`);
      }
      if (!missing.length) return { ok: true, detail: human(have) };
      return { ok: false, detail: `缺 ${missing.length} 个文件：${missing.slice(0, 2).join('、')}${missing.length > 2 ? ' …' : ''}` };
    },
    async fix() {
      const files = [
        ['config.json', 938],
        ['tokenizer.json', 439124],
        ['tokenizer_config.json', 366],
        ['special_tokens_map.json', 125],
        ['onnx/model.onnx', 406953171],
      ];
      let allOk = true;
      for (const [rel, size] of files) {
        const dest = path.join(MODEL_DIR, rel);
        if (fs.existsSync(dest) && fs.statSync(dest).size === size) { console.log(dim(`  已有 ${rel}`)); continue; }
        const url = `${HF}/${MODEL_REPO}/resolve/main/${rel}`;
        try {
          await download(url, dest, size);
        } catch (e) {
          console.log(red(`  ${rel} 下载失败：${e.message}`));
          allOk = false;
        }
      }
      return allOk;
    },
    manual: `模型走镜像 ${HF}；下不动就把环境变量 HF_ENDPOINT 指到别的镜像再跑一次。`,
  },
  {
    id: 'python',
    title: 'Python 3（语音合成要用）',
    required: false,
    where: '系统 PATH',
    url: 'https://www.python.org/downloads/',
    note: '安装时记得勾上「Add python.exe to PATH」，不然脚本找不到它。',
    check() {
      const exe = findPython();
      if (!exe) return { ok: false, detail: '没找到 python（语音会退回纯文字，不影响聊天）' };
      const r = run(exe, ['--version']);
      return { ok: true, detail: String(r.stdout || r.stderr || '').trim() || exe };
    },
    manual: '到 https://www.python.org/downloads/ 装一个，安装时勾上「Add python.exe to PATH」。',
  },
  {
    id: 'edge-tts',
    title: 'edge-tts（语音合成）',
    required: false,
    where: '当前 Python 的 site-packages',
    url: 'https://pypi.org/project/edge-tts/',
    note: '免费的在线朗读，不花 key 的钱。不装语音就退回纯文字。',
    check() {
      const exe = findPython();
      if (!exe) return { ok: false, detail: '先要有 Python' };
      const r = run(exe, ['-m', 'pip', 'show', 'edge-tts'], { timeout: 30000 });
      if (r.status !== 0) return { ok: false, detail: '没装（语音会退回纯文字）' };
      const m = /^Version:\s*(.+)$/m.exec(String(r.stdout || ''));
      return { ok: true, detail: m ? `v${m[1].trim()}` : '已装' };
    },
    async fix() {
      const exe = findPython();
      if (!exe) return false;
      const regs = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.aliyun.com/pypi/simple', ''];
      for (const reg of regs) {
        const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'edge-tts'];
        if (reg) args.push('-i', reg);
        console.log(dim(`  pip install edge-tts${reg ? `（源 ${reg}）` : ''}…`));
        const ok = await new Promise((resolve) => {
          const ch = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
          ch.on('exit', (code) => resolve(code === 0));
          ch.on('error', () => resolve(false));
        });
        if (ok) return true;
      }
      return false;
    },
    manual: '也可以手动：python -m pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple',
  },
  {
    id: 'ffmpeg',
    title: 'ffmpeg / ffprobe（语音时长、收语音转文字）',
    required: false,
    where: '系统 PATH',
    url: 'https://www.gyan.dev/ffmpeg/builds/',
    note: '下 release 版解压，把 bin 目录加进 PATH。或者 winget install Gyan.FFmpeg。',
    check() {
      const a = run('ffprobe', ['-version']);
      const b = run('ffmpeg', ['-version']);
      const okA = a.status === 0;
      const okB = b.status === 0;
      if (okA && okB) {
        const v = /ffprobe version (\S+)/.exec(String(a.stdout || ''));
        return { ok: true, detail: v ? `v${v[1]}` : '已装' };
      }
      return { ok: false, detail: `ffprobe ${okA ? '有' : '缺'} / ffmpeg ${okB ? '有' : '缺'}（只影响语音）` };
    },
    manual: 'winget install Gyan.FFmpeg 或到 https://www.gyan.dev/ffmpeg/builds/ 下 release 版解压后把 bin 加进 PATH。',
  },
  {
    id: 'napcat',
    title: 'NapCatQQ（QQ 那边的桥）',
    required: true,
    where: 'config.json → napcat.wsHost',
    url: 'https://napneko.github.io/guide/start-install',
    note: '装完在里面开「WebSocket 服务器」，端口跟 config.json 里填的一致（默认 3001）。',
    check() {
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* ignore */ }
      const raw = String(cfg?.napcat?.wsHost || 'ws://127.0.0.1:3001');
      let host = '127.0.0.1';
      let port = 3001;
      try {
        const u = new URL(raw);
        host = u.hostname || host;
        port = Number(u.port || 80);
      } catch { /* 用默认 */ }
      return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const done = (v, d) => { try { s.destroy(); } catch { /* ignore */ } resolve({ ok: v, detail: d }); };
        s.setTimeout(1200);
        s.once('connect', () => done(true, `${host}:${port} 在听`));
        s.once('timeout', () => done(false, `${host}:${port} 连不上（NapCat 没开？）`));
        s.once('error', () => done(false, `${host}:${port} 连不上（NapCat 没开？）`));
      });
    },
    manual: 'NapCat 是外部程序，包不带。装好后在里面开「WebSocket 服务器」，端口跟 config.json 里一致。',
  },
  {
    id: 'config',
    title: 'config.json（你的配置）',
    required: true,
    where: '仓库根目录',
    url: '',
    missingLabel: '未就绪',
    note: '还没有就双击 setting.bat 跑一遍设置向导，填完会自己生成。',
    check() {
      const p = path.join(ROOT, 'config.json');
      if (!fs.existsSync(p)) return { ok: false, detail: '还没有（没跑过 setting.bat）' };
      let cfg = null;
      try {
        cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        return { ok: false, detail: `文件在，但 JSON 解析不了：${e.message}` };
      }
      const bad = [];
      if (!Number(cfg?.bot?.qq)) bad.push('bot.qq（机器人 QQ 号）');
      if (!Number(cfg?.bot?.owners?.[0])) bad.push('bot.owners（谁能指挥它）');
      const m = cfg?.models?.[Number(cfg?.activeModel ?? 0)];
      if (!m) bad.push('models（一个模型都没配）');
      else {
        if (!String(m.baseURL || '').trim()) bad.push('models[].baseURL');
        if (!String(m.model || '').trim()) bad.push('models[].model');
        if (!String(m.apiKey || '').trim()) bad.push('models[].apiKey');
      }
      if (bad.length) return { ok: false, detail: `还差：${bad.join('、')}` };
      return { ok: true, detail: `机器人 ${cfg.bot.qq}，主人 ${cfg.bot.owners[0]}，模型 ${m.name || m.model}` };
    },
    manual: '双击 setting.bat 重填，回车保留原值，改完会覆盖写回。',
  },
];

// ---------- 工具 ----------
function findPython() {
  const cands = [String(process.env.PYTHON || '').trim(), 'python', 'python3', 'py'];
  for (const c of cands.filter(Boolean)) {
    const r = run(c, ['--version'], { timeout: 15000 });
    if (r.status === 0 && /Python\s+3\./i.test(String(r.stdout || r.stderr || ''))) return c;
  }
  return '';
}

function bar(done, total) {
  if (!total) return '';
  const w = 24;
  const n = Math.min(w, Math.round((done / total) * w));
  return `[${'█'.repeat(n)}${'░'.repeat(w - n)}] ${String(Math.floor((done / total) * 100)).padStart(3)}%`;
}

async function download(url, dest, expectedSize) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let start = 0;
  if (fs.existsSync(part)) start = fs.statSync(part).size;
  if (fs.existsSync(dest)) {
    if (!expectedSize || fs.statSync(dest).size === expectedSize) return true;
    fs.rmSync(dest, { force: true });
    start = 0;
  }
  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    throw new Error(`连不上 ${new URL(url).host}（${e.message}）`);
  }
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  if (start > 0 && res.status === 200) {
    start = 0; // 服务器不认断点，从头来
    fs.rmSync(part, { force: true });
  }
  const total = Number(res.headers.get('content-length') || 0) + start;
  const fd = fs.openSync(part, start > 0 ? 'a' : 'w');
  let got = start;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      fs.writeSync(fd, chunk);
      got += chunk.length;
      const now = Date.now();
      if (TTY && now - last > 200) {
        last = now;
        stdout.write(`\r  ${bar(got, total)} ${human(got)} / ${human(total)}   `);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (TTY) stdout.write(`\r  ${bar(got, total)} ${human(got)} / ${human(total)}   \n`);
  if (expectedSize && got !== expectedSize) {
    throw new Error(`下完是 ${got} 字节，应该 ${expectedSize}（多半被截断，重跑一次会接着下）`);
  }
  fs.renameSync(part, dest);
  return true;
}

// ---------- 主流程 ----------
const picked = ONLY.length ? items.filter((it) => ONLY.includes(it.id)) : items;

// 预检（start.bat 调）不出清单，只在真有拦路的项时说话
const QUIET = MODE === 'preflight';

if (!QUIET) {
  console.log('');
  console.log(bold(`=== 鲸鱼机器人一键包 · 依赖自检 ===`));
  console.log(dim(`目录：${ROOT}`));
  console.log(dim(`模式：${MODE === 'check' ? '只看不动' : MODE === 'install' ? '缺什么补什么' : '先看清单再问'}`));
  console.log('');
}

const results = [];
for (const it of picked) {
  if (TTY && !QUIET) process.stdout.write(`  检查 ${it.title} …\r`);
  let r;
  try { r = await it.check(); } catch (e) { r = { ok: false, detail: `检查时出错：${e.message}` }; }
  results.push({ it, ...r });
  if (QUIET) continue;
  const mark = r.ok ? green('✔') : it.required ? red('✘') : yellow('○');
  const tag = it.required ? '' : dim('（可选）');
  console.log(`${mark} ${it.title}${tag}`);
  if (r.ok) {
    console.log(`    ${green('已安装')} ${dim(r.detail)}`);
  } else {
    console.log(`    ${red(it.missingLabel || '未安装')} ${r.detail}`);
    if (it.url) console.log(`    ${cyan('下载')} ${it.url}`);
    if (it.note) console.log(`    ${dim(it.note)}`);
  }
}

const missing = results.filter((r) => !r.ok);
if (QUIET) {
  const bad = results.filter((r) => PREFLIGHT_IDS.includes(r.it.id) && !r.ok);
  if (bad.length) {
    console.log('');
    console.log(red('启动前先补这几样：'));
    for (const r of bad) {
      console.log(`  ${red('✘')} ${r.it.title} —— ${r.detail}`);
      if (r.it.url) console.log(`    ${cyan('下载')} ${r.it.url}`);
      if (r.it.note) console.log(`    ${dim(r.it.note)}`);
    }
    console.log('');
    console.log(dim('补完再双击 start.bat。也可以直接双击 check-deps.bat 让它帮你装。'));
  }
  process.exit(bad.length ? 1 : 0);
}
const hardMissing = missing.filter((r) => r.it.required);
const softMissing = missing.filter((r) => !r.it.required);

console.log('');
if (!missing.length) {
  console.log(green('全都齐了，直接双击 start.bat 就行。'));
  process.exit(0);
}
console.log(
  `${bold('缺')} ${missing.length} 项：${red(`必需 ${hardMissing.length}`)}，${yellow(`可选 ${softMissing.length}`)}` +
    dim('（地址都在上面每项下面）'),
);

if (MODE === 'check') {
  process.exit(hardMissing.length ? 1 : 0);
}

// 哪些能自动补：有 fix 的
const fixable = missing.filter((r) => typeof r.it.fix === 'function');
const unfixable = missing.filter((r) => typeof r.it.fix !== 'function');

let todo = [];
if (MODE === 'install') {
  todo = fixable;
} else {
  if (!fixable.length) {
    console.log('');
    console.log(yellow('没有能自动补的，按上面的地址手动装。'));
    process.exit(hardMissing.length ? 1 : 0);
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`\n要现在补上这 ${fixable.length} 项吗？(Y/n) `)).trim().toLowerCase();
  rl.close();
  todo = ans === 'n' || ans === 'no' ? [] : fixable;
}

if (!todo.length) {
  console.log(dim('没动。想补的时候再双击一次。'));
  process.exit(hardMissing.length ? 1 : 0);
}

console.log('');
let failed = 0;
for (const r of todo) {
  console.log(bold(`\n▶ ${r.it.title}`));
  let ok = false;
  try { ok = await r.it.fix(); } catch (e) { console.log(red(`  出错：${e.message}`)); }
  if (!ok) {
    failed++;
    console.log(red('  没成功。'));
    if (r.it.manual) console.log(dim(`  ${r.it.manual}`));
    continue;
  }
  // 补完再验一次，别报个假的成功
  let again = { ok: false, detail: '' };
  try { again = await r.it.check(); } catch { /* ignore */ }
  if (again.ok) {
    console.log(green(`  ✔ 好了（${again.detail}）`));
  } else {
    failed++;
    console.log(yellow(`  装完了但自检还是不过：${again.detail}`));
  }
}

console.log('');
if (failed) {
  console.log(yellow(`有 ${failed} 项没搞定，看上面的提示。`));
} else {
  console.log(green('补完了。'));
}
if (unfixable.length) {
  console.log(dim(`还有 ${unfixable.length} 项要手动装：${unfixable.map((r) => r.it.title).join('、')}`));
}
console.log(dim('装完双击 start.bat 启动；想再看一遍就再跑一次这个脚本。'));
process.exit(failed ? 1 : 0);
