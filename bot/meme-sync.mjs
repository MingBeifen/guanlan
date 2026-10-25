// 收藏夹只读同步（2026-10-25 B 层）：把观澜自己号 QQ 里的收藏表情，搬进本地表情库。
//
// 为什么只读：`add_custom_face` 也能写，但那是改她 QQ 账号的**云端收藏**（手机端会同步可见），
// 按 2026-10-25 定的「云端数据三道闸」，写入必须走单独的口令路径（见 whale-bot 里的 handleFavUpload），
// 不许一个定时任务顺手就写。所以这个模块只做 fetch，不做 add。
//
// 实测（2026-10-25）：`fetch_custom_face_detail({count:200})` 返回 22 条、198~218ms；
// count 传 48/300/1000 都是 22 → 库存就这么多，不是接口截断。
// 本地路径全是空的（personal_emoji\Ori 0 文件、isExist 全 false），所以只能走 url 下载。
import fs from "node:fs";
import path from "node:path";

const FAV_COUNT = 200;
// 下载中转目录：先落这里再交给 absorb()，因为 absorb 只吃本机路径。
// 放 mine 的兄弟目录而不是 media 里——media 根目录有 7 天清理，中转文件不该混进去。
const TMP_DIR_SUFFIX = "-tmp";

function sniffable(buf) {
  return Buffer.isBuffer(buf) && buf.length > 12;
}

/**
 * 从图片字节里读宽高（只认 png / gif / jpg 三种最常见的），给一条「形状」标签用。
 * 读不出来就返回空 shape——**不要猜**，猜错会把「竖图」贴到宽图上，比没有更坏。
 */
function imageMeta(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      // PNG: IHDR 宽高在 16..24
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { w, h, shape: shapeOf(w, h) };
    }
    if (buf.toString("latin1", 0, 3) === "GIF") {
      const w = buf.readUInt16LE(6);
      const h = buf.readUInt16LE(8);
      return { w, h, shape: shapeOf(w, h) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: 扫 SOF 段
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return { w, h, shape: shapeOf(w, h) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch {
    /* 读不出来就算了 */
  }
  return { w: 0, h: 0, shape: "" };
}

function shapeOf(w, h) {
  if (!w || !h) return "";
  const r = w / h;
  if (r > 1.25) return "宽图";
  if (r < 0.8) return "竖图";
  return "方图";
}

export function createMemeSync({ callAction, memeLib, log = () => {} }) {
  let running = false;

  /**
   * 拉一次收藏夹，把没有的下载进库，把这回没出现的标 stale（不删文件）。
   * @param {{dryRun?:boolean, maxDownload?:number}} opts
   */
  async function sync(opts = {}) {
    const dryRun = opts.dryRun === true;
    const maxDownload = Number(opts.maxDownload ?? 60);
    if (running) return { ok: false, reason: "already-running" };
    running = true;
    try {
      const r = await callAction("fetch_custom_face_detail", { count: FAV_COUNT }, 30000);
      // 注意（2026-10-26 修的）：callAction 已经在收消息那层把外层消息解开了，
      // 这里拿到的是 OneBot 的 data 本体，不是 {status, retcode, data} 那个壳。
      // 以前判断 r.status !== "ok" 永远成立，所以这个同步一次都没成功过。
      // 壳上已经由 callAction 判过成败（失败会 reject 到这里被 catch 兜住）。
      const rows = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : null;
      if (!rows) {
        return { ok: false, reason: `接口返回里没有列表 data=${typeof r}` };
      }
      const idx = memeLib.load();
      // 现有库里 source 含 fav 的：记个集合，用来标 stale
      const known = new Set();
      for (const [key, it] of Object.entries(idx.items)) {
        if ((it.sources ?? []).includes("fav") && it.status === "active") known.add(key);
      }
      let added = 0;
      let skipped = 0;
      let failed = 0;
      let staled = 0;
      let bytes = 0;
      const seenKeys = new Set();

      for (const e of rows) {
        const url = String(e?.url ?? "");
        if (!url) {
          failed++;
          continue;
        }
        // md5 已经能对上库里的某个 key 前缀（我们主键是 sha256，不是 md5，所以只能靠下载后比）
        // —— 为了省带宽：先看 filestem（md5）是否出现在库的 desc/tags 之外，无法判断就直接下载。
        if (added >= maxDownload) {
          skipped++;
          continue;
        }
        if (dryRun) {
          added++;
          skipped++;
          continue;
        }
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) {
            failed++;
            log(`收藏表情下载失败 ${res.status}: ${String(e.md5 ?? "").slice(0, 8)}`);
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          if (!sniffable(buf)) {
            failed++;
            continue;
          }
          // 先落中转目录再吸收：absorb() 只吃本机路径，也方便失败重来
          const tmpDir = memeLib.dir + TMP_DIR_SUFFIX;
          fs.mkdirSync(tmpDir, { recursive: true });
          const tmp = path.join(tmpDir, `${String(e.md5 ?? "x").slice(0, 16)}.bin`);
          fs.writeFileSync(tmp, buf);
          // 给每条补「可检索线索」（2026-10-25 实测逼出来的）：
          // QQ 收藏表情的 desc / ocrWord / modifyWord 实测**全是空的**（22 条 0 条有字），
          // 光靠 desc 切词，`[表情:猫]` 在这批上永远找不到。所以补三类结构标签：
          //   · 收藏序号「第N张」——她可以说「发收藏里第三张」
          //   · 尺寸形态 「宽图 / 方图 / 竖图」——能说「那张竖着的」
          //   · 文件 md5 前 8 位——人工核对用
          const idxNo = rows.indexOf(e) + 1;
          const meta = imageMeta(buf);
          const autoTags = [`第${idxNo}张`, `${idxNo}`, meta.shape].filter(Boolean);
          const got = memeLib.absorb(tmp, {
            source: "fav",
            desc: e.desc,
            subType: 1,
            tags: autoTags,
          });
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* 删不掉不影响 */
          }
          if (got) {
            seenKeys.add(got.key);
            if (got.isNew) {
              added++;
              bytes += buf.length;
            } else {
              skipped++;
            }
          } else {
            failed++;
          }
        } catch (err) {
          failed++;
          log(`收藏表情下载异常: ${err?.message ?? err}`);
        }
      }

      // 库里 source=fav 但这批里没出现的 → stale（不删文件，只是不再拿来发）
      if (!dryRun) {
        for (const key of known) {
          if (seenKeys.has(key)) continue;
          if (idx.items[key]) {
            idx.items[key].status = "stale";
            staled++;
          }
        }
        if (staled) memeLib.save(idx);
      }

      return { ok: true, total: rows.length, added, skipped, failed, staled, bytes, dryRun };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    } finally {
      running = false;
    }
  }

  return { sync };
}
