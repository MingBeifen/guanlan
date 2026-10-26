// 本地转发口（channel-pack 的 OpenAI 兼容网关）读数 + 写进配置。
//
// 这个网关不是我们起的：它由桌面 DSH 里的 dsh-our-free-model 插件（vendor/channel-pack）
// 挂起来，默认 127.0.0.1:8326，密钥落在 <DSH_HOME>\openai-gateway\api-key。
// 它同时供给：白嫖渠道（workbuddy / trae / qoder ... 十三个账号渠道）、
// our-free-model 免费车道、以及桌面 DSH 自己的 deepseek-official。
//
// 代价必须记住：网关活在桌面 DSH 进程里，桌面关了机器人就没模型。
// 界面上要一直把这个前提摆出来，不能让人以为它是常驻服务。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const KEY_FILE = path.join(DSH_HOME, 'openai-gateway', 'api-key');

// 端口跟插件一致：DSH_OPENAI_GATEWAY_PORT 覆盖，否则默认 8326。
export const GATEWAY_PORT = Number(process.env.DSH_OPENAI_GATEWAY_PORT) || 8326;
export const gatewayBase = () => `http://127.0.0.1:${GATEWAY_PORT}/v1`;

export function gatewayKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return /^[A-Za-z0-9_-]{20,}$/.test(k) ? k : '';
  } catch {
    return '';
  }
}

// 网关只下发 id / owned_by / name / description / input / reasoning，不给上下文窗口。
// our-free-model 的 description 里写了「1024K context」，能捞就捞；捞不到按 131072 保守取值
// ——取小了只是更早压缩上下文，不会把请求打挂。
function contextOf(model) {
  const m = /(\d+(?:\.\d+)?)\s*K\s*context/i.exec(String(model.description || ''));
  if (m) {
    const n = Math.round(Number(m[1]) * 1024);
    if (Number.isFinite(n) && n >= 8192) return n;
  }
  return 131072;
}

function toRow(model) {
  const id = String(model.id || '');
  return {
    id,
    provider: String(model.owned_by || id.split('/')[0] || ''),
    name: String(model.name || id),
    input: Array.isArray(model.input) ? model.input : ['text'],
    reasoning: Boolean(model.reasoning),
    contextWindow: contextOf(model),
    description: String(model.description || ''),
  };
}

const PROVIDER_LABEL = {
  workbuddy: 'WorkBuddy（白嫖渠道）',
  'our-free-model': '免费车道',
  'our-free-model-region': '免费车道 · 地区限制',
  'deepseek-official': 'DeepSeek 官方',
};

export function providerLabel(id) {
  return PROVIDER_LABEL[id] || id;
}

/** 读网关：能不能连上、密钥在不在、有哪些模型。 */
export async function gatewayStatus() {
  const key = gatewayKey();
  const base = gatewayBase();
  const common = { port: GATEWAY_PORT, baseURL: base, keyFound: Boolean(key) };
  if (!key) {
    return { ok: false, up: false, ...common, error: '还没生成网关密钥：桌面 DSH 里的 Our Free Model 没起过', models: [] };
  }
  try {
    const res = await fetch(base + '/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, up: true, ...common, error: `网关回了 ${res.status}`, models: [] };
    }
    const data = await res.json();
    const models = (Array.isArray(data.data) ? data.data : []).map(toRow);
    const groups = {};
    for (const m of models) groups[m.provider] = (groups[m.provider] || 0) + 1;
    return {
      ok: true,
      up: true,
      ...common,
      error: '',
      models,
      groups: Object.keys(groups).map((id) => ({ id, label: providerLabel(id), count: groups[id] })),
    };
  } catch (e) {
    return { ok: false, up: false, ...common, error: '连不上网关：' + String(e?.message || e), models: [] };
  }
}

/** config.json 里哪几条是走这个网关的。 */
export function isGatewayModel(m) {
  const b = String(m?.baseURL || '').replace(/\/+$/, '');
  return b === gatewayBase().replace(/\/+$/, '') || /^http:\/\/127\.0\.0\.1:(\d+)\/v1$/.test(b);
}
