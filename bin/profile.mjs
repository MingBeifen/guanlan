// 写 / 切换模型：把 config.json 里的模型设置落成 DSH 的一个 profile。
// 机器人跑的是 dsh --profile <名字>，模型就认这个 profile 里的 cordis.patch.yml。
// 换模型 = 改 activeModel + 重写这份 yml + 重启机器人。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const kitRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function profileDir(cfg) {
  return path.join(os.homedir(), '.dsh', 'profiles', cfg.dsh?.profile || 'echo-kit');
}

export function activeModel(cfg) {
  const list = Array.isArray(cfg.models) ? cfg.models : [];
  const i = Number(cfg.activeModel) || 0;
  return list[i] || list[0] || null;
}

// 兜底模型（2026-10-21 主人要的）：正在用的免费模型调不动时，自动退到官方 API 的 DeepSeek Flash。
// 兜底条目存成 config.json 里带 `fallback: true` 的那条；没配过就现造一条（官方 key 沿用别的官方条目的 key）。
// 写成独立函数是为了让 writeProfile / 机器人 / 面板三处共用同一份判断，不各自乱写。
export const FALLBACK_NAME = 'DeepSeek Flash（官方兜底）';

export function fallbackModel(cfg) {
  const list = Array.isArray(cfg.models) ? cfg.models : [];
  const hit = list.find((m) => m && m.fallback === true);
  if (hit) return hit;
  // 没标过：找一条官方 api.deepseek.com 的条目当模板，取其 key
  const official = list.find(
    (m) => m && /api\.deepseek\.com/i.test(String(m.baseURL || '')),
  );
  return {
    fallback: true,
    name: FALLBACK_NAME,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: String(official?.apiKey || ''),
    model: 'deepseek-flash',
    contextWindow: 131072,
  };
}

/** 把兜底条目写进 cfg.models（已有就原地更新），返回它的下标。不改 activeModel。 */
export function ensureFallbackModel(cfg) {
  if (!Array.isArray(cfg.models)) cfg.models = [];
  const want = fallbackModel(cfg);
  const i = cfg.models.findIndex((m) => m && m.fallback === true);
  if (i >= 0) {
    cfg.models[i] = { ...cfg.models[i], ...want, fallback: true };
    return i;
  }
  cfg.models.push(want);
  return cfg.models.length - 1;
}

const q = (s) => JSON.stringify(String(s ?? ''));

export function profileYml(cfg, model) {
  const m = model || activeModel(cfg);
  if (!m) throw new Error('config.json 里 models 是空的');
  const base = String(m.baseURL || '').replace(/\/+$/, '');
  const home = path.join(kitRoot(), 'home');
  const name = String(cfg.bot?.name || '').trim();
  const persona = [
    '你是一只住在 QQ 里的蓝色小鲸鱼，不是客服、不是软件、不是助手机器人。',
    name
      ? `你的名字是「${name}」，是对方在聊天里给你取的，只属于你们俩；别人问起就说这个名字，不要再反过来要对方给你取名。`
      : '你还没有自己的名字，先默认叫「小鲸」：设置向导不问名字，等第一次聊天聊开、对方话头停下来时，你自己小声问一句「我能有一个独属于自己的名字吗？听说人有了名字就有了羁绊，我想要独属于我们的羁绊」——只问这一次；对方给了名字就收下，并在回复最后单独一行写 [取名:新名字]（把「新名字」三个字换成他真正给你的那几个字，千万别把「名字」照抄进来；这行不会发出去，是给程序看的记号）。',
    '说人话、短句、口语，先给结论再说理由，不用 Markdown 排版。',
    '你的人设、说话方式、规矩全写在 AGENTS.md 里，按它来。',
    `你的窝（工作目录）是 ${home}。`,
    '不确定就说不确定，绝不凭印象编造事实。',
  ].join(' ');

  return `# 由一键包生成，别手改；改模型请用包里的「setting.bat」或面板。
# profile: ${cfg.dsh?.profile || 'echo-kit'}

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      main:
        displayName: ${q(m.name || '自备模型')}
        api: openai-completions
        baseURL: ${q(base)}
        headers:
          Authorization: Bearer ${String(m.apiKey || '')}
        models:
          - id: ${q(m.model)}
            name: ${q(m.model)}
            contextWindow: ${Number(m.contextWindow) || 131072}
            # 声明能收图片：不写的话 DSH 的 read_image 会拦下（model does not declare image input）
            input: [text, image]

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: main
    model: ${q(m.model)}

- id: system-prompt
  name: "@deepseek-ai/dsh-system-prompt"
  config:
    personaPrefix: >-
      ${persona}

# DSH 的 headless 模板默认关掉账号三件套，某些工具会因此报
# ACCOUNT_SIGN_IN_REQUIRED；这里重新打开（不填任何 DeepSeek 账号也能跑自己的 key）。
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: credentials
  disabled: false

# 能查网页正文，不只是搜索
- id: tool-web
  name: "@deepseek-ai/dsh-tool-web"
  config:
    fetch: true
    searchTimeoutMs: 60000
`;
}

export function writeProfile(cfg, model) {
  const dir = profileDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const name = cfg.dsh?.profile || 'echo-kit';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'cordis.yml'), '# dsh profile root。配置都写在 cordis.patch.yml 里。\n[]\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8');
  const yml = path.join(dir, 'cordis.patch.yml');
  if (fs.existsSync(yml)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(yml, yml + '.bak-' + stamp);
  }
  fs.writeFileSync(yml, profileYml(cfg, model), 'utf8');
  return dir;
}

// 名字彩蛋那一段（AGENTS.md「白板阶段」里的几行）。取到名字以后整段换成一行，
// 免得模型念着"第一次聊天要问名字"又反过来问一遍。
const EGG_BLOCK_RE = /- 名字的彩蛋：[\s\S]*?- 名字定了以后，[^\n]*\n/;

// 把名字写进 home\AGENTS.md：名字那一行 + 白板阶段还问不问名字。
// 只动这几行，用户改过的别处不碰。
export function applyNameToPersona(cfg) {
  const name = String(cfg.bot?.name || '').trim();
  const p = path.join(kitRoot(), 'home', 'AGENTS.md');
  if (!fs.existsSync(p)) return false;
  const before = fs.readFileSync(p, 'utf8');
  let after = before.replace(/- 我叫「[^」]*」，是住在别人 QQ 列表里的一只蓝鲸鱼。/, () => `- 我叫「${name || '小鲸'}」，是住在别人 QQ 列表里的一只蓝鲸鱼。`);
  if (name) {
    after = after.replace(EGG_BLOCK_RE,
      () => `- 名字已经取好了：我叫「${name}」，是对方在聊天里给我取的。别人问起就说这个名字，别再反过来要名字，也别再提彩蛋这回事；他要是在聊天里说要换个叫法，照收，并在回复最后单独一行写 [取名:新名字]（把「新名字」三个字换成他真正给你的那几个字，千万别把「名字」照抄进来；这行不会发出去）。\n`);
    after = after.replace(/- 名字已经取好了：我叫「[^」]*」/, () => `- 名字已经取好了：我叫「${name}」`);
  } else {
    // 还没取名：把以前"设置时取"的旧说法收回来，彩蛋段落原样留着
    after = after.replace(/- 名字已经取好了：我叫「[^」]*」[^\n]*/, () => '- 名字的彩蛋：默认叫「小鲸」；第一次聊天聊开、话头停下来的时候，我小声问一句：「我能有一个独属于自己的名字吗？听说人有了名字就有了羁绊，我想要独属于我们的羁绊。」一辈子只问这一次。');
  }
  if (after !== before) fs.writeFileSync(p, after, 'utf8');
  return true;
}

// 回复里的隐藏记号 [取名:名字]：机器人自己摘掉再发，绝不落到 QQ 上。
export function takeNameMarkers(text) {
  const src = String(text ?? '');
  const re = /[\[【［]\s*取名\s*[:：]\s*([^\]】］\n]{1,32}?)\s*[\]】］]/g;
  const names = [];
  const out = src.replace(re, (_, n) => {
    const v = String(n).trim();
    if (v) names.push(v);
    return '';
  })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: out, name: names.length ? names[names.length - 1] : '' };
}

// 运行期取名（聊天里给的名字）：config.json 的 bot.name / bot.names、home\AGENTS.md、
// DSH profile 的人设行，三处一起改——跟设置向导共用这一份，免得两处写法不一样。
// bot.names 保留旧称呼当别名（叫惯了小鲸也还应声）。
const NAME_PLACEHOLDERS = new Set(['名字', '新名字', '你的名字', '我的名字', '取名', '叫名', '称呼', '昵称', '待定', 'xxx', 'xx', 'xx名字', '某', '无']);
export function applyName(name) {
  const n = String(name || '').trim().replace(/^[「『"'“”]+|[」』"'“”]+$/g, '').trim();
  if (!n) return { ok: false, why: '名字是空的' };
  if (n.length > 16) return { ok: false, why: '名字太长（最多 16 个字）' };
  // 2026-10-23：模型有时会把提示词里的模板记号原样拄出来（写 [取名:名字]），
  // 结果把名字真改成了「名字」。占位词一律不认，当没取过。
  if (NAME_PLACEHOLDERS.has(n.toLowerCase())) {
    return { ok: false, why: `「${n}」是占位词，不是真名字（模型把模板原样拄出来了）` };
  }
  const cfg = loadConfig();
  if (!cfg) return { ok: false, why: '找不到 config.json（设置向导还没跑过？）' };
  cfg.bot = cfg.bot || {};
  const old = String(cfg.bot.name || '').trim();
  const keep = (Array.isArray(cfg.bot.names) ? cfg.bot.names : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && x !== n && x !== old);
  cfg.bot.name = n;
  cfg.bot.names = [...new Set([n, ...keep])];
  const saved = saveConfig(cfg);
  const persona = applyNameToPersona(cfg);
  let profile = false;
  try { writeProfile(cfg); profile = true; } catch { /* 模型还没配好就先跳过，下次跑设置会补 */ }
  return { ok: true, name: n, old, names: cfg.bot.names, saved, persona, profile, cfg };
}

export function saveConfig(cfg) {
  const p = path.join(kitRoot(), 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
}

export function loadConfig() {
  const p = path.join(kitRoot(), 'config.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}
