#!/usr/bin/env node
// 往 SnowLuma 注入机器人 QQ（观澜 bot.qq），并做「注入后账号核对」。
//
// 为什么要单独一个脚本：
//   · SnowLuma 默认 hookAutoLoad=false，起来后不会自动注入任何 QQ；
//   · 但如果把 hookAutoLoad 改成 true，它会注入**所有** QQ 主进程——
//     包括主人自己那个号（萤 1000000001）。2026-10-27 我就是这么把观澜的
//     重启播报发到了主人自己的号上。所以必须「只注入指定 profile 的那个进程」。
//
// 用法：
//   node bin/snowluma-inject.mjs --pid <QQ主进程PID>
//   node bin/snowluma-inject.mjs --pid <PID> --dry   仅核对，不注入
//
// 退出码：0 = 已注入且账号核对通过 / 1 = 失败或核对不符

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function arg(name, def = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const cfg = readCfg();
const sl = cfg.snowluma ?? {};
const WEBUI = String(sl.webuiHost || "http://127.0.0.1:5099").replace(/\/+$/, "");
const USER = sl.user || "admin";
const PASS = sl.password || "";
const BOT_UIN = String(sl.botUin || cfg.bot?.qq || "");
const PID = Number(arg("pid", "0"));
const DRY = flag("dry");

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}
function die(msg) {
  log("✗", msg);
  process.exit(1);
}

async function api(p, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(WEBUI + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      j = { raw: txt };
    }
    return { status: r.status, ...j };
  } finally {
    clearTimeout(t);
  }
}

// 等 WebUI 起来
async function waitWebui(seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await api("/api/status");
      if (r && r.status !== undefined && !r.error) return true;
      if (r && (r.ok !== undefined || r.version !== undefined)) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function findBotPid() {
  // 注意：这里不用 /api/processes 的 account，因为 QQ 未登录时它是 null。
  // 由调用方（autostart.ps1）按 --user-data-dir 找出 PID 传进来。
  return PID;
}

async function main() {
  if (!BOT_UIN) die("config.json 里没有 snowluma.botUin / bot.qq，不知道要注入哪个号");
  if (!PASS) die("config.json 里没有 snowluma.password，无法登录 WebUI");
  if (!PID) die("缺少 --pid <QQ主进程PID>（由 autostart.ps1 按 --user-data-dir 找出来）");

  log(`WebUI=${WEBUI}  目标账号=${BOT_UIN}  QQ进程=${PID}${DRY ? "  [dry]" : ""}`);

  if (!(await waitWebui(60))) die("SnowLuma WebUI 连不上（进程没起来？）");

  // SnowLuma 的初始密码是一次性的，改过之后旧 token 全失效，所以每次都重新登录。
  const lg = await api("/api/login", { method: "POST", body: { username: USER, password: PASS } });
  if (!lg.token) die(`登录失败：${lg.message || lg.status || "unknown"}`);
  const token = lg.token;
  log("WebUI 登录成功");

  const before = await api("/api/processes", { token });
  const row = (before.list || []).find((p) => Number(p.pid) === PID);
  if (!row) die(`SnowLuma 没枚举到 PID ${PID}（QQ 没起来？或完整性级别不对）`);
  log(`目标进程当前：injected=${row.injected} status=${row.status} account=${JSON.stringify(row.account)}`);

  if (row.injected && row.loggedIn) {
    log("已经是注入且登录状态，不需要再注入");
    if (row.account?.uin && String(row.account.uin) !== BOT_UIN) {
      die(`⚠️ 已注入的账号是 ${row.account.uin}(${row.account.nickname})，不是 ${BOT_UIN}——请人工处理`);
    }
    process.exit(0);
  }

  if (DRY) {
    log("[dry] 到此为止，不注入");
    process.exit(0);
  }

  const ld = await api(`/api/processes/${PID}/load`, { method: "POST", token, body: {} });
  if (!ld.success) die(`注入失败：${ld.message || JSON.stringify(ld).slice(0, 200)}`);
  log("注入指令已下发，等它连上…");

  // 等登录，然后**核对账号**——这一步是 2026-10-27 那次事故换来的，不能省。
  let acc = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await api("/api/processes", { token });
    const cur = (now.list || []).find((p) => Number(p.pid) === PID);
    if (cur && cur.loggedIn && cur.status === "online") {
      acc = cur.account;
      log(`已登录：uin=${cur.uin} nickname=${acc?.nickname}`);
      break;
    }
  }
  if (!acc) die("注入后 30 秒内没登录成功（可能要人工扫码）");

  if (String(acc.uin) !== BOT_UIN) {
    // 注错号了：立刻卸掉，别让它以主人的身份往外说话。
    log(`✗ 账号不符！期望 ${BOT_UIN}，实际 ${acc.uin}(${acc.nickname})，立刻卸载`);
    await api(`/api/processes/${PID}/unload`, { method: "POST", token, body: {} });
    die("已卸载，未发送任何消息");
  }

  log("✓ 账号核对通过");
}

main().catch((e) => die(e?.stack || String(e)));
