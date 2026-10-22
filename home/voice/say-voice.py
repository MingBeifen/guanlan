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


def main():
    ap = argparse.ArgumentParser(description="把文字念成 mp3")
    ap.add_argument("--text", help="要念的话")
    ap.add_argument("--out", help="输出的 mp3 路径")
    ap.add_argument("--voice", default="zh-CN-YunxiaNeural", help="音色名")
    ap.add_argument("--rate", default="-5%", help="语速，如 -5%% / +10%%")
    ap.add_argument("--pitch", default="-2Hz", help="音调，如 -2Hz / +5Hz")
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

    async def run():
        tts = edge_tts.Communicate(text, args.voice, rate=args.rate, pitch=args.pitch)
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
