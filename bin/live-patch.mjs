// DSH 流式补丁（原型）——不改 app.asar，用 NODE_OPTIONS=--import 在加载期改写投影模块。
//
// 原理：
//   1) DSH 的 agent loop 每收到一个模型流分片就 dispatch.emit("agent/assistant-stream", { frame })
//      （dsh-agent-loop/lib/index.js：`(frame) => { this.dispatch.emit("agent/assistant-stream", { frame }); }`）
//   2) 但 `--json` 投影只把「已提交」的 assistant/message 吐成 text，所以外面看不到流。
//   3) 这里把 dsh-headless 的 json-stream 模块换成带包装的版本：保留原 projectJsonRun 全部行为，
//      只在同一轮里额外订阅 agent/assistant-stream，把 text-delta 分片吐成 {"type":"text_live"}。
//      text 事件语义不变（仍只表示已提交内容），text_live 是**明确的实时预览**，被重试作废时由下一片/最终 text 覆盖。
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

const TARGET = /\/@deepseek-ai\/dsh-headless\/lib\/json-stream-[^/]*\.js$/;

const EXPORT_LINE = /export \{ projectJsonRun as n, boundJsonLine as t \};/;

const WRAPPER = String.raw`
function __liveProject(ctx, agent, sink, options = {}) {
	let stopLive = () => {};
	try {
		const off = ctx.on("agent/assistant-stream", (payload) => {
			try {
				const frame = payload?.frame;
				if (!frame || frame.type !== "chunk") return;
				const chunk = frame.chunk;
				if (!chunk || chunk.type !== "text-delta") return;
				const text = typeof chunk.text === "string" ? chunk.text : "";
				if (!text) return;
				sink.write(JSON.stringify({ type: "text_live", attemptId: frame.attemptId, index: chunk.index, turn: frame.turn, step: frame.step, text }) + "\n");
			} catch { /* 预览失败绝不能影响主流程 */ }
		});
		if (typeof off === "function") stopLive = off;
	} catch { /* 老版本没有这个事件就退化成按步 */ }
	const handle = projectJsonRun(ctx, agent, sink, options);
	return {
		finish: (text) => handle.finish(text),
		dispose: () => {
			try { stopLive(); } catch { /* ignore */ }
			handle.dispose();
		},
	};
}
export { __liveProject as n, boundJsonLine as t };
`;

registerHooks({
  load(url, context, nextLoad) {
    if (!TARGET.test(url)) return nextLoad(url, context);
    const source = readFileSync(new URL(url), "utf8");
    if (!EXPORT_LINE.test(source)) {
      process.stderr.write(`[live-patch] 投影模块导出形态变了，跳过打补丁：${url}\n`);
      return { format: "module", source, shortCircuit: true };
    }
    const patched = source.replace(EXPORT_LINE, WRAPPER);
    process.stderr.write("[live-patch] 已注入 text_live 预览\n");
    return { format: "module", source: patched, shortCircuit: true };
  },
});
