#!/usr/bin/env node
/**
 * dsh-abd-rescue 回归回放：拿本机全部现存会话日志，逐轮重放
 * core.shouldRescue 的判定，验证：
 *   1. 每个「异常结束 + 该轮有 ABD 工具结果」的轮次都会被判定为 rescue=true
 *      （即用户再也不会对着满屏红色 ABD 错误手动打「继续」）；
 *   2. 用户自己按的停止（user-abort）绝不触发；
 *   3. 正常完成的轮次不触发。
 *
 * 数据源：$DSH_HOME/sessions/<ws-slug>/session-<uuid>/session.v4.jsonl.zstd
 * 会话日志是 zstd 多帧（每行一帧，magic 0xFD2FB528），zstdDecompressSync 只解
 * 第一帧 —— 所以用流式逐帧扫描（峰值内存 = 单帧大小），解码器与审计脚本
 * ~/.dsh/tmp/audit-question-paused.mjs 同源。
 *
 * 用法：node tools/replay.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as core from "../lib/core.js";
import { resolveDshHome } from "../lib/config.js";

const HOME = resolveDshHome();
const MAGIC = 0xfd2fb528;

function decodeFrame(buf, s, e) {
  return zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
}

/**
 * 流式逐帧扫描。onLine(lineStr) 逐行回调；帧解不开时把下一个边界并入重试，
 * 整个文件都试尽才放弃该起点（防假 magic 造成死循环/丢帧）。
 */
function scanFrames(buf, onLine) {
  const bounds = [0];
  for (let j = 8; j + 4 <= buf.length; j += 1) {
    if (buf.readUInt32LE(j) === MAGIC) bounds.push(j);
  }
  let bad = 0;
  let i = 0;
  while (i < bounds.length) {
    const s = bounds[i];
    let decoded = null;
    let consumedUntil = -1;
    for (let k = i + 1; k <= bounds.length; k += 1) {
      const e = k < bounds.length ? bounds[k] : buf.length;
      if (e <= s) continue;
      try {
        decoded = decodeFrame(buf, s, e);
        consumedUntil = k;
        break;
      } catch {
        if (e === buf.length) break;
      }
    }
    if (decoded === null) {
      bad += 1;
      i += 1;
      continue;
    }
    for (const line of decoded.split("\n")) {
      if (line) onLine(line);
    }
    decoded = null;
    i = consumedUntil;
  }
  return bad;
}

function reasonClass(reason) {
  if (!reason) return "no-turn-end";
  if (reason.kind === "aborted") {
    const r = reason.reason;
    if (r && typeof r === "object" && r.kind === "hook" && String(r.reason || "").includes("unstuck")) {
      return "guard-question-pause";
    }
    const cause = typeof r === "string" ? r : r?.kind || "";
    if (cause === "user" || cause === "cancel") return "user-stop";
    return `aborted-${cause || "unknown"}`;
  }
  return reason.kind;
}

// ---- 扫描全部会话文件 ----
const root = path.join(HOME, "sessions");
const files = [];
for (const ws of fs.readdirSync(root)) {
  const wsDir = path.join(root, ws);
  if (!fs.statSync(wsDir).isDirectory()) continue;
  for (const sid of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, sid, "session.v4.jsonl.zstd");
    if (fs.existsSync(f)) files.push(f);
  }
}
console.log(`扫描 ${files.length} 个会话文件…\n`);

const verdicts = new Map(); // class -> count
const cases = [];
let framesBad = 0;

for (const f of files) {
  const sid = path.basename(path.dirname(f));
  const abdByTurn = new Map(); // turn -> [event]
  const turnEnds = new Map(); // turn -> {seq, reason}
  const humanAfter = new Map(); // turnEndSeq -> 是否有人后来手动发了含「继续」的消息

  const bad = scanFrames(fs.readFileSync(f), (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type === "tool/result" && core.isAbortedBeforeDispatch(o)) {
      const t = o.data?.turn;
      if (typeof t === "number") {
        if (!abdByTurn.has(t)) abdByTurn.set(t, []);
        abdByTurn.get(t).push(o);
      }
      return;
    }
    if (o.type === "turn/end" && typeof o.data?.turn === "number") {
      turnEnds.set(o.data.turn, { seq: o.seq || 0, reason: o.data.reason });
      humanAfter.set(o.data.turn, false);
      return;
    }
    if (o.type === "user/message" && o.data?.source?.kind === "user") {
      // 真实事件里 user/message 的正文在 data.content（实测 keys: content,source,role,id）；
      // 兜底 data.message.content（另一种可能的形状）。
      const blocks = o.data?.content ?? o.data?.message?.content;
      const text = Array.isArray(blocks) ? blocks.map((b) => String(b?.text ?? "")).join("") : "";
      if (text.includes("继续")) {
        // 标记「之后」的每一条 turn/end：真人手动续过了
        for (const [t, end] of turnEnds) {
          if ((o.seq || 0) > end.seq) humanAfter.set(t, true);
        }
      }
    }
  });
  if (bad > 0) framesBad += bad;

  for (const [turn, abds] of abdByTurn) {
    const end = turnEnds.get(turn);
    // 重放：只看 turn/end 及之前可见的事件（ABD 结果 + turn/end 本身）。
    const visible = [...abds, { type: "turn/end", seq: end?.seq || 0, data: { turn, reason: end?.reason || null } }];
    const info = core.inspectTurnEnd(visible);
    const decision = core.shouldRescue(info, abds.length);
    const cls = decision.rescue
      ? `rescue(${reasonClass(end?.reason)})`
      : `skip:${decision.why}`;
    verdicts.set(cls, (verdicts.get(cls) || 0) + 1);
    cases.push({
      sid,
      turn,
      abdCount: abds.length,
      cls,
      reason: reasonClass(end?.reason),
      userContinuedLater: end ? humanAfter.get(turn) === true : null,
    });
  }
}

console.log("判定汇总（每个含 ABD 的轮次 × 插件判定）：");
for (const [k, v] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k} = ${v}`);
}
console.log(`\n解不开的帧起点：${framesBad}（应为 0 或极少）`);

const rescued = [...verdicts.entries()].filter(([k]) => k.startsWith("rescue")).reduce((a, [, v]) => a + v, 0);
const stranded = cases.filter((c) => c.cls.startsWith("rescue") && c.userContinuedLater === false).length;
console.log(`\n会触发补发：${rescued} 个轮次；其中用户后来没手动续过（纯靠插件才能救）：${stranded}`);

// ---- 断言 ----
// skip:user-abort 只允许出现在真·用户按停的轮次上；守卫自掐被误判成用户停止 = 漏网。
const bad = cases.filter((c) => c.cls === "skip:user-abort" && c.reason !== "user-stop");
// skip:not-abnormal（工具被拦但轮次最终正常完成）= 设计上正确：
// 调用被取消后模型已换路走完，补发反而怂恿重试（与 unstuck toolAbort 注释语义一致）。
const byDesign = cases.filter((c) => c.cls === "skip:not-abnormal").length;
// skip:no-turn-end = 老格式/已关闭会话：整个文件没有 turn/end 事件（或日志在
// 轮次中途截断）。活体插件同样救不了（onStatus 拿不到 turn/end 直接 return），
// 不是判定错误，不计漏判。
const closed = cases.filter((c) => c.cls === "skip:no-turn-end").length;
const missed = cases.filter((c) => {
  const why = c.cls.startsWith("skip:") ? c.cls.split(":")[1] : "";
  return c.cls.startsWith("skip:") && !["user-abort", "disposed", "not-abnormal", "no-turn-end"].includes(why);
});
console.log(bad.length === 0 ? "✔ 没有守卫自掐轮次被误判成用户停止" : `✘ ${bad.length} 个守卫自掐轮次被误判！`);
console.log(`✔ ${byDesign} 个「工具被拦但轮次最终正常完成」= 设计上正确跳过`);
console.log(`✔ ${closed} 个「无 turn/end」= 已关闭/老格式会话，活体不可救，不计漏判`);
console.log(missed.length === 0 ? "✔ 没有异常结束+ABD 的轮次被漏判" : `✘ ${missed.length} 个轮次被漏判！`);
if (bad.length > 0 || missed.length > 0) process.exitCode = 1;
