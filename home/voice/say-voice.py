#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把一段中文念成 mp3，给机器人发语音用。

用法（机器人自己会这么调，一般不用手跑）：
    python say-voice.py --text "要说的话" --out out.mp3 --voice zh-CN-YunxiaNeural \
        --rate -5% --pitch -2Hz

依赖只有一个：edge-tts（免费的在线朗读，不花 key 的钱）
    pip install edge-tts

想换音色：python say-voice.py --list
    zh-CN-XiaoxiaoNeural   女声，温柔
    zh-CN-XiaoyiNeural     女声，活泼
    zh-CN-YunxiNeural      男声，少年
    zh-CN-YunxiaNeural      男声，童声（默认，像小孩）
    zh-CN-YunjianNeural    男声，沉稳

关于语气（2026-10-24 加）：
机器人会在 [语音] 段里写 [语气:开心] 这种标记，剥掉之后会多传两个参数过来：
    --speed 1.08            语速倍率（语气映射来的）
    --emotion-ref xxx.wav   分情绪参考音（本脚本是 edge-tts，用不上，照收）
本脚本用 edge-tts 的 rate 来近似「语速」，所以 --speed 会被折算成 rate 的百分比。
--emotion-ref / --emotion-ref-text 只是**为了参数兼容**才接收：edge-tts 的音色由 --voice
决定，换不了参考音。想真做情绪音色，就把这个脚本换成 GPT-SoVITS 那类本地 TTS。

注意：
- 这个脚本要联网（edge-tts 走微软的在线朗读接口），断网就合成不出来。
- 输出是 mp3；转 silk 是 NapCat 那边自己做的事，这里不管。
- 失败一律非 0 退出并在 stderr 说原因，机器人看到非 0 就不发这条语音。
"""

import argparse
import asyncio
import sys


def die(msg, code=1):
    sys.stderr.write(str(msg) + "\n")
    sys.exit(code)


def merge_rate(base_rate, speed):
    """把基础 rate（如 "-5%"）和语气倍率（如 1.08）折成一个 rate 百分比。

    edge-tts 的 rate 只认 "+10%" / "-5%" 这种字符串。
    speed=1.0 时原样返回 base_rate；否则叠加：-5% 配 1.08 → -5% + 8% = +3%。
    """
    if speed is None or abs(speed - 1.0) < 1e-9:
        return base_rate
    # 解析基础 rate
    base_pct = 0
    s = str(base_rate or "").strip()
    if s.endswith("%"):
        try:
            base_pct = int(round(float(s[:-1])))
        except ValueError:
            base_pct = 0
    delta = int(round((speed - 1.0) * 100))
    total = base_pct + delta
    # edge-tts 的 rate 有效范围大致 -50% ~ +100%，超了夹住
    total = max(-50, min(100, total))
    return "%+d%%" % total


def main():
    ap = argparse.ArgumentParser(description="把文字念成 mp3")
    ap.add_argument("--text", help="要念的话")
    ap.add_argument("--out", help="输出的 mp3 路径")
    ap.add_argument("--voice", default="zh-CN-YunxiaNeural", help="音色名")
    ap.add_argument("--rate", default="-5%", help="语速，如 -5%% / +10%%")
    ap.add_argument("--pitch", default="-2Hz", help="音调，如 -2Hz / +5Hz")
    # 语气相关（2026-10-24）：机器人会传，必须收下，否则 argparse 直接报错退出
    ap.add_argument("--speed", type=float, default=1.0, help="语速倍率（语气映射来的）")
    ap.add_argument("--emotion-ref", default="", help="分情绪参考音（edge-tts 用不上，仅兼容）")
    ap.add_argument("--emotion-ref-text", default="", help="参考音对应文本（同上）")
    ap.add_argument("--list", action="store_true", help="列出可用音色")
    args = ap.parse_args()

    try:
        import edge_tts
    except ImportError:
        die("没装 edge-tts。先跑：pip install edge-tts")

    if args.list:
        voices = asyncio.run(edge_tts.list_voices())
        for v in voices:
            if str(v.get("Locale", "")).startswith("zh-"):
                print("%-28s %s" % (v.get("ShortName", ""), v.get("Gender", "")))
        return

    if not args.text or not args.out:
        die("缺参数：--text 和 --out 都要给")

    text = args.text.strip()
    if not text:
        die("要念的话是空的")

    rate = merge_rate(args.rate, args.speed)

    async def run():
        tts = edge_tts.Communicate(text, args.voice, rate=rate, pitch=args.pitch)
        await tts.save(args.out)

    try:
        asyncio.run(run())
    except Exception as e:  # 网络、音色名写错、被限流，都从这里出去
        die("合成失败：%s" % e)

    import os
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        die("合成完没拿到文件：%s" % args.out)


if __name__ == "__main__":
    main()
