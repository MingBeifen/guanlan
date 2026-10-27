// 出站对账（2026-10-27 主人选的 B 项：**只记账、不拦**）
//
// 为什么要它：她能直连 SnowLuma 的 OneBot HTTP 口（http://127.0.0.1:3000/）调 send_group_msg，
// 那条路绕过了发件箱（落盘/重试）、档案、白名单、频率闸——2026-10-27 09:30 实测过一次。
// 主人给的选择是「先只加审计日志」（拦的风险：一旦误判就把正常回话掐了）。
//
// 怎么对账：SnowLuma 每真正发出一条消息都会在自己的日志里留一行
//   `09:30:48 DEBUG [1000000006] [Bridge.Action] send_group_msg params=message=[len=1] group_id=1000000002`
// 我们自己也在发件箱发出成功时记一笔「这条是我发的」。一分钟一结账：
// SnowLuma 那边有、我们这边没有的，就是「没走发件箱的发送」。
//
// 边界（故意选保守，宁可少报不误报）：
//  - 按 (kind,target,分钟) 计数，比较时把前后各一分钟的自己的账也算进来（±1 分钟抖动）。
//  - 只有 SnowLuma 比我们**多**才记；我们比它多（重连补投、SnowLuma 重启丢日志）一律不记。
//  - 只认 send_group_msg / send_private_msg 两种动作。
import fs from "node:fs";
import path from "node:path";

const MINUTE = 60 * 1000;

function minuteKey(kind, target, minute) {
  return `${kind}:${target}:${minute}`;
}

export function createEgressAudit({
  logsDir,
  outPath,
  log = () => {},
  enabled = true,
  tickMs = 60 * 1000,
} = {}) {
  const mine = new Map(); // "group:1000000003:1793068800000" -> 条数
  let timer = null;
  let offset = 0;
  let curFile = "";
  let started = false;
  let skipToEnd = false; // 第一次见到某份日志：从「此刻」开始对账，不追溯历史

  function noteSelfSend(kind, target) {
    if (!enabled) return;
    const k = minuteKey(
      kind,
      String(target),
      Math.floor(Date.now() / MINUTE) * MINUTE,
    );
    mine.set(k, (mine.get(k) ?? 0) + 1);
  }

  function newestLog() {
    try {
      const names = fs
        .readdirSync(logsDir)
        .filter((n) => /^snowluma-\d{4}-\d{2}-\d{2}\.log$/.test(n))
        .sort();
      const n = names[names.length - 1];
      return n ? path.join(logsDir, n) : "";
    } catch {
      return "";
    }
  }

  // 日志行 → {minute, kind, target}；不认识的返回 null。
  // 行首是 SnowLuma 自己的钟点（无日期），日期取文件名里的那一天。
  const LINE_RE =
    /^(\d{2}):(\d{2}):(\d{2})\s+\S+\s+.*?\[Bridge\.Action\]\s+(send_group_msg|send_private_msg)\s+params=.*?(?:group_id|user_id)=(\d+)/;

  function scanOnce() {
    if (!enabled) return; // 关掉开关 = 一条也不记（连读日志都不读）
    const file = newestLog();
    if (!file) return;
    if (file !== curFile) {
      curFile = file;
      offset = 0; // 换天/换文件：先跳到末尾，只对「以后的」账
      skipToEnd = true;
    }
    let raw;
    try {
      const size = fs.statSync(file).size;
      if (skipToEnd) {
        // 不追溯：启动前 SnowLuma 日志里的每一条都会被当成「没走发件箱」，一开服务就刷 38 条假账。
        offset = size;
        skipToEnd = false;
        log("[出站审计] 从这一刻开始对账（历史消息不追溯）");
        return;
      }
      if (size <= offset) return; // 没长
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
      offset = size;
    } catch {
      return;
    }
    const day = String(path.basename(file)).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    if (!day) return;
    const dayAt = new Date(`${day}T00:00:00+08:00`).getTime();
    if (!Number.isFinite(dayAt)) return;

    const snow = new Map(); // 同 key -> 条数
    for (const line of raw.split("\n")) {
      const m = LINE_RE.exec(line);
      if (!m) continue;
      const [, hh, mm, , action, target] = m;
      const at =
        dayAt +
        (Number(hh) * 3600 + Number(mm) * 60) * 1000 -
        0; // 只到分钟，秒下面留着给 ±1 分钟容差吃
      const kind = action === "send_group_msg" ? "group" : "private";
      const minute = Math.floor(at / MINUTE) * MINUTE;
      const k = minuteKey(kind, target, minute);
      snow.set(k, (snow.get(k) ?? 0) + 1);
    }
    if (!snow.size) return;

    const own = (kind, target, minute) =>
      (mine.get(minuteKey(kind, target, minute - MINUTE)) ?? 0) +
      (mine.get(minuteKey(kind, target, minute)) ?? 0) +
      (mine.get(minuteKey(kind, target, minute + MINUTE)) ?? 0);

    const extra = [];
    for (const [k, sent] of snow) {
      const [kind, target, minuteStr] = k.split(":");
      const minute = Number(minuteStr);
      const ours = own(kind, target, minute);
      if (sent > ours) extra.push({ kind, target, minute, sent, ours });
    }
    if (extra.length) {
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.appendFileSync(
          outPath,
          extra.map((x) => JSON.stringify({ at: Date.now(), ...x, note: "没走发件箱" })).join("\n") + "\n",
          "utf8",
        );
      } catch {
        /* 记不上就算了，下个 tick 还有机会 */
      }
      const brief = extra
        .map((x) => `${x.kind}:${x.target} 多 ${x.sent - x.ours} 条`)
        .join("，");
      log(`[出站审计] 有 ${extra.length} 处发送没走发件箱：${brief}（只记账，不拦）`);
    }

    // 自己的账只留最近 5 分钟，防止长期增长
    const cut = Date.now() - 5 * MINUTE;
    for (const k of mine.keys()) {
      if (Number(k.split(":")[2]) < cut) mine.delete(k);
    }
  }

  function start() {
    if (!enabled || started) return;
    started = true;
    timer = setInterval(() => {
      try {
        scanOnce();
      } catch (e) {
        log("[出站审计] 出错了（不影响回话）：", e?.message ?? String(e));
      }
    }, tickMs);
    timer.unref?.();
    log(
      `[出站审计] 开着（只记账不拦）：每 ${Math.round(tickMs / 1000)}s 拿 SnowLuma 日志和发件箱对一次账`,
    );
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
  }

  return { noteSelfSend, start, stop, scanOnce };
}
