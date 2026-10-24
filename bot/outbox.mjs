// 发件箱（2026-10-19 技术优化第一条）
// 要解决的问题：原来 reply() 直接 callAction 发消息，WS 一断、NapCat 一抖、动作超时，
// 这条消息就没了，日志里只剩一句失败。现在先把消息写进 home\outbox.json（落盘才算数），
// 再由一个单线程泵按顺序发；失败按 2s→5s→15s→30s 退避重试，重启后接着发没发完的；
// 超过 maxAgeMs 还没发出去（多半是关了一整夜）就不发了，记进 outbox-dead.jsonl。
//
// 两个已知取舍：
//  - 至少一次：动作超时后对方可能其实已经收到，重试会造成重复。聊天场景下重复一句
//    比丢一句好，认了；要彻底避免得让 NapCat 回 message_id，做不到就不装。
//  - 顺序：严格 FIFO，队头没发出去时后面的等着（不会插队）。所以队头卡住超过
//    maxAgeMs 会被判过期丢掉，后面的才动。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  maxTries: 5,
  maxAgeMs: 10 * 60 * 1000,
  tickMs: 1500,
  backoffMs: [0, 2000, 5000, 15000, 30000],
  blobLimit: 64 * 1024,
  maxItems: 200,
};

export function createOutbox(opts = {}) {
  const { dir, send } = opts;
  if (!dir) throw new Error('createOutbox: 缺少 dir');
  if (typeof send !== 'function') throw new Error('createOutbox: 缺少 send');
  const log = opts.log ?? (() => {});
  const isReady = opts.isReady ?? (() => true);
  const onDead = opts.onDead ?? null;
  const onSent = opts.onSent ?? null;
  const maxTries = opts.maxTries ?? DEFAULTS.maxTries;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULTS.maxAgeMs;
  const tickMs = opts.tickMs ?? DEFAULTS.tickMs;
  const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;
  const blobLimit = opts.blobLimit ?? DEFAULTS.blobLimit;
  const maxItems = opts.maxItems ?? DEFAULTS.maxItems;

  fs.mkdirSync(dir, { recursive: true });
  const queuePath = path.join(dir, 'outbox.json');
  const deadPath = path.join(dir, 'outbox-dead.jsonl');
  const blobDir = path.join(dir, 'media', 'outbox');

  let items = [];
  let busy = false;
  let timer = null;
  let seq = 0;

  // 队列文件用"写临时文件再改名"落盘：半截写坏的文件宁可没有，也不能让泵读到坏 JSON 卡死。
  // 2026-10-24 体检修：Windows 上目标文件可能被杀软/索引/备份脚本短时占用，rename 会报
  // EPERM 而不是排到后面去。实测裸循环 300 次失败 22 次（7.3%），加 5 次 5ms 间隔的重试后
  // 200 次 0 失败。写盘失败时消息只活在内存里，进程一崩就丢，所以这里必须重试。
  function writeQueue() {
    const tmp = `${queuePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', 'utf8');
    } catch (e) {
      log('发件箱写盘失败:', e?.message ?? String(e));
      return;
    }
    // rename 是同步的，只能忙等几个毫秒重试；最多约 25ms，比丢一条消息划算。
    for (let i = 0; i < 6; i++) {
      try {
        fs.renameSync(tmp, queuePath);
        return;
      } catch (e) {
        const code = e?.code ?? '';
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
          log('发件箱写盘失败:', e?.message ?? String(e));
          return;
        }
        if (i === 5) {
          log(`发件箱写盘失败（重试 5 次仍被占用）: ${e?.message ?? String(e)}`);
          return;
        }
        // 同步忙等：这段代码在泵的心跳里，没有 await 可用，5ms×5 也就 25ms
        const until = Date.now() + 5;
        while (Date.now() < until) {
          /* 等文件句柄被放掉 */
        }
      }
    }
  }

  function remove(item) {
    items = items.filter((x) => x.id !== item.id);
  }

  function blobPath(id) {
    return path.join(blobDir, `${id}.json`);
  }

  function dropBlob(item) {
    if (item?.payload?.type !== 'blob') return;
    try {
      fs.unlinkSync(item.payload.file);
    } catch {
      /* 已经不在了就算了 */
    }
  }

  function dead(item, reason, detail) {
    try {
      fs.appendFileSync(
        deadPath,
        JSON.stringify({ at: new Date().toISOString(), reason, detail, ...item }) + '\n',
        'utf8',
      );
    } catch (e) {
      log('发件箱死信写盘失败:', e?.message ?? String(e));
    }
    log(`发件箱丢弃（${reason}）：${item.summary || item.id}${detail ? '；' + detail : ''}`);
    try {
      onDead?.(item, { reason, detail: detail ?? '' });
    } catch (e) {
      log('发件箱 onDead 回调异常:', e?.message ?? String(e));
    }
  }

  // 大消息（带图 / 很长的段）别塞进 outbox.json：单独落一个文件，队列里只留路径。
  function stashPayload(id, payload) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {
      return payload;
    }
    if (size <= blobLimit) return payload;
    try {
      fs.mkdirSync(blobDir, { recursive: true });
      const file = blobPath(id);
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
      return { type: 'blob', file, size, origType: payload?.type ?? null };
    } catch (e) {
      log('发件箱大消息暂存失败，仍然放进队列:', e?.message ?? String(e));
      return payload;
    }
  }

  function readPayload(item) {
    if (item.payload?.type !== 'blob') return item.payload;
    try {
      return JSON.parse(fs.readFileSync(item.payload.file, 'utf8'));
    } catch {
      return null;
    }
  }

  function load() {
    let raw = [];
    try {
      raw = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    } catch {
      raw = [];
    }
    items = (Array.isArray(raw) ? raw : []).filter((x) => x && x.id && x.payload && x.kind && x.target);
    for (const it of items) {
      it.tries = Number(it.tries ?? 0);
      it.notBefore = Number(it.notBefore ?? 0);
      it.ts = Number(it.ts ?? Date.now());
    }
    if (items.length) log(`发件箱：接着发上次没发完的 ${items.length} 条`);
  }

  function enqueue(kind, target, payload, o = {}) {
    const id = `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item = {
      id,
      ts: Date.now(),
      notBefore: Date.now() + Math.max(0, Number(o.delayMs ?? 0)),
      kind: kind === 'group' ? 'group' : 'private',
      target: Number(target),
      payload: stashPayload(id, payload),
      summary:
        o.summary ??
        payload?.summary ??
        (typeof payload?.message === 'string' ? payload.message.slice(0, 40) : String(payload?.type ?? '')),
      tries: 0,
    };
    items.push(item);
    // 队列只留最近 maxItems 条：真堆到这么多，说明链路已经坏了很久，新的优先。
    while (items.length > maxItems) {
      const old = items.shift();
      dropBlob(old);
      dead(old, 'overflow', `队列超过 ${maxItems} 条`);
    }
    writeQueue();
    void pump().catch((e) => log('发件箱发送异常:', e?.message ?? String(e)));
    return id;
  }

  async function pump() {
    if (busy) return;
    if (!isReady()) return; // 连接没起来就先等着，不烧重试次数
    busy = true;
    try {
      const now = Date.now();
      const expired = items.filter((it) => now - it.ts > maxAgeMs);
      if (expired.length) {
        for (const it of expired) {
          dropBlob(it);
          dead(it, 'expired', `放了 ${Math.round((now - it.ts) / 60000)} 分钟没发出去`);
        }
        items = items.filter((it) => !expired.includes(it));
        writeQueue();
      }

      // 严格按顺序：只看队头，队头没到时间就都等着；发完一条接着看下一条（没延迟就一口气发完）
      for (;;) {
        const item = items[0];
        if (!item || item.notBefore > Date.now()) return;

        const payload = readPayload(item);
        if (!payload) {
          dropBlob(item);
          remove(item);
          writeQueue();
          dead(item, 'blob-missing', '大消息的暂存文件读不到');
          continue;
        }

        try {
          const sent = await send(item, payload);
          try {
            onSent?.(item, payload, sent);
          } catch (e) {
            log('发件箱 onSent 回调异常:', e?.message ?? String(e));
          }
          remove(item);
          dropBlob(item);
          writeQueue();
          log(`发件箱：发出 1 条（剩 ${items.length} 条）`);
        } catch (e) {
          const detail = String(e?.message ?? e).slice(0, 200);
          item.tries = Number(item.tries ?? 0) + 1;
          item.lastError = detail;
          if (e?.permanent || item.tries >= maxTries) {
            remove(item);
            dropBlob(item);
            writeQueue();
            dead(item, e?.permanent ? 'permanent' : 'retries', e?.permanent ? detail : `重试 ${item.tries} 次仍失败：${detail}`);
          } else {
            const wait = backoffMs[Math.min(item.tries, backoffMs.length - 1)];
            item.notBefore = Date.now() + wait;
            writeQueue();
            log(`发件箱：第 ${item.tries} 次没发出去，${Math.round(wait / 1000)} 秒后重试：${detail}`);
          }
          return;
        }
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    load();
    if (timer) return;
    timer = setInterval(() => {
      pump().catch((e) => log('发件箱巡检异常:', e?.message ?? String(e)));
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    enqueue,
    pump,
    load,
    size: () => items.length,
    pending: () => items.map((x) => ({ id: x.id, kind: x.kind, target: x.target, tries: x.tries, summary: x.summary })),
  };
}
