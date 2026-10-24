// 浏览器驱动：不开 chromedriver，直接起一个带调试端口的 Edge/Chrome，通过 CDP 使唤它
// 用法：node tools\cdp.mjs <动作> [参数...]
//   cdp.mjs text  <url> [选择器]            打开页面，取标题+正文
//   cdp.mjs shot  <url> <输出png路径>        打开页面，截图
//   cdp.mjs eval  <url> <js表达式>           打开页面，跑一段 js 取值
// 注意：浏览器必须是 node 自己的子进程（stdio ignore），否则会在命令结束时被一起收走
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  throw new Error("没找到 Edge 或 Chrome");
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function putJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "PUT", timeout: 5000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

async function launch() {
  const exe = pickBrowser();
  const port = 9700 + Math.floor(Math.random() * 200);
  // 用户目录必须放在工作区里：沙箱下 TEMP 里的 profile 浏览器起不来
  const profile = path.resolve("home/tmp", `cdp-profile-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    "--headless=new",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--no-crash-upload",
    "about:blank",
  ];
  const child = spawn(exe, args, { stdio: "inherit", windowsHide: true });
  child.on("error", (e) => console.error("spawn error:", e.message));

  const started = Date.now();
  while (Date.now() - started < 25000) {
    await sleep(400);
    try {
      const v = await getJson(port, "/json/version");
      if (v && v.webSocketDebuggerUrl) return { child, port, version: v.Browser };
    } catch { /* 还没起来 */ }
  }
  child.kill();
  throw new Error(`浏览器 25 秒内没开出调试端口（${exe}）`);
}

async function openPage(port, url) {
  const tab = await putJson(port, "/json/new?about:blank");
  if (!tab.webSocketDebuggerUrl) throw new Error("拿不到标签页调试地址");

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连不上")), { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => {
      if (pending.has(myId)) { pending.delete(myId); reject(new Error(`CDP 超时: ${method}`)); }
    }, 30000);
  });

  await send("Page.enable");
  await send("Runtime.enable");

  // 等真正加载完（带超时兜底）
  const loaded = new Promise((resolve) => {
    const t = setTimeout(resolve, 20000);
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === "Page.loadEventFired") { clearTimeout(t); resolve(); }
      } catch { /* 忽略 */ }
    });
  });
  await send("Page.navigate", { url });
  await loaded;
  await sleep(600);

  return {
    send,
    close: () => { try { ws.close(); } catch { /* 忽略 */ } },
  };
}

async function evaluate(page, expression) {
  const r = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "js 报错");
  return r.result?.value;
}

async function main() {
  const [action, url, arg] = process.argv.slice(2);
  if (!action) throw new Error("用法: node tools\\cdp.mjs text|shot|eval <url> [参数]");

  const { child, port, version } = await launch();
  console.log(`浏览器: ${version} 端口 ${port}`);
  let page;
  try {
    page = await openPage(port, url);
    const title = await evaluate(page, "document.title");
    console.log("标题:", title);

    if (action === "text") {
      const expr = arg
        ? `(()=>{const e=document.querySelector(${JSON.stringify(arg)});return e?e.innerText:"(找不到这个选择器)"})()`
        : `document.body ? document.body.innerText : "(没有 body)"`;
      const text = await evaluate(page, expr);
      console.log("--- 正文 ---");
      console.log(String(text ?? "").slice(0, 4000));
    } else if (action === "shot") {
      const out = path.resolve(arg || `home/media/web-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
      const buf = fs.readFileSync(out);
      console.log(`截图: ${out} ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} ${Math.round(buf.length / 1024)}KB`);
    } else if (action === "eval") {
      const v = await evaluate(page, arg);
      console.log("结果:", JSON.stringify(v));
    } else {
      throw new Error(`不认识的动作: ${action}`);
    }
  } finally {
    page?.close();
    child.kill();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
