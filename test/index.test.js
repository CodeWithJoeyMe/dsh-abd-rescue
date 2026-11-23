/**
 * dsh-abd-rescue 装配层集成测试（node --test）。
 *
 * 假 ctx（事件总线 + effect）+ 假 agent，走真实的 apply() 事件链。
 * 核心用例取自 2026-11-23 线上漏发 c5ee0860 turn 7：
 *   plan（scheduled）→ 会话被关闭（agent disposed）→ fire 时 agent 已死
 *   → 旧实现 state.delete 让 fire 静默 return，补发无声丢失。
 *   新实现：挂起（rescue-pending）→ 同一 session 新 agent 注册（onStatus）
 *   → 恢复（rescue-resumed）→ 重验重发。
 *
 * 每个用例独立 dshHome（日志文件不串），apply() 时读 DSH_HOME。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../lib/index.js";

const GUARD_REASON = { kind: "aborted", reason: { kind: "hook", reason: "unstuck-unanswered-question" } };
const TURN_END_SEQ = 100;

const homes = [];
after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abd-rescue-test-"));
  homes.push(home);
  process.env.DSH_HOME = home;
  return home;
}

function abdResult(turn, seq) {
  return {
    type: "tool/result",
    seq,
    data: {
      turn,
      step: 70,
      message: { role: "tool", content: [{ type: "text", text: "Error: tool call aborted before dispatch" }], isError: true },
      error: { name: "AbortError", code: "ABORTED_BEFORE_DISPATCH" },
    },
  };
}

function turnEnd(turn, seq) {
  return { type: "turn/end", seq, data: { turn, reason: GUARD_REASON } };
}

function userMsg(seq, kind, text = "继续") {
  // 真实事件形状：正文在 data.content（实测 keys: content,source,role,id）。
  return { type: "user/message", seq, data: { content: [{ type: "text", text }], source: { kind }, role: "user" } };
}

/** 假 agent：followup 记录补发；session.events 给快照读。 */
function makeAgent(id, events, { status = "idle" } = {}) {
  const sent = [];
  return {
    id,
    status,
    session: { id, events },
    followup: (msg) => sent.push(msg),
    _sent: sent,
  };
}

/** 假 ctx：事件总线 + effect 登记（apply 的装配全靠这两个）。 */
function makeCtx() {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        listeners.set(event, listeners.get(event).filter((h) => h !== handler));
      };
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") ctx._cleanups.push(cleanup);
      return cleanup;
    },
    _cleanups: [],
    emit(event, payload) {
      for (const h of (listeners.get(event) || []).slice()) h(payload);
    },
  };
  return ctx;
}

function boot() {
  const ctx = makeCtx();
  plugin.apply(ctx, {
    enabled: true,
    autoContinue: true,
    continueMax: 3,
    delayMs: 0,
    backoffMs: [0, 0, 0],
    resumeDelayMs: 0,
  });
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logEvents(home) {
  const fp = path.join(home, "abd-rescue", "abd-rescue.jsonl");
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lastEventOf(home, name) {
  const lines = logEvents(home).filter((e) => e.event === name);
  return lines[lines.length - 1] || null;
}

test("c5ee0860 场景：plan 后会话关闭 → 挂起 → 重开自动重发", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-closed-reopened";
  // 关闭前的事件流：1 个 ABD + 守卫自掐的 turn/end（seq 100）。
  const history = [abdResult(7, 98), turnEnd(7, TURN_END_SEQ)];

  const a1 = makeAgent(id, history);
  ctx.emit("agent/status", { agent: a1, status: "idle" });
  assert.ok(lastEventOf(home, "rescue-scheduled"), "plan 阶段应留 rescue-scheduled");

  // 会话在发送窗口里被关闭（fire 的 0ms 定时器还没跑）。
  ctx.emit("agent/disposed", { agent: a1 });

  // fire 跑了：agent 已死 → 挂起，而不是取消。
  await sleep(20);
  assert.equal(lastEventOf(home, "rescue-pending")?.why, "agent-disposed", "应留 rescue-pending(agent-disposed)");
  assert.equal(lastEventOf(home, "rescue-sent"), null, "挂起阶段不应发送");
  assert.equal(a1._sent.length, 0);

  // 会话重开：同一 session id 的新 agent 对象，事件流含历史 + end-seed（无新消息）。
  const reopened = [...history, { type: "session/end-seed", seq: 105 }];
  const a2 = makeAgent(id, reopened);
  ctx.emit("agent/status", { agent: a2, status: "idle" });

  await sleep(20);
  assert.ok(lastEventOf(home, "rescue-resumed"), "重开应留 rescue-resumed");
  assert.ok(lastEventOf(home, "rescue-sent"), "恢复后应留 rescue-sent");
  assert.equal(a2._sent.length, 1, "补发应打到新 agent 上");
  assert.equal(a2._sent[0].source.kind, "dsh-abd-rescue", "source.kind 必须是自己的");

  // 重复的 idle 事件不得再发（pendingSeq / lastRescueSeq 双去重）。
  ctx.emit("agent/status", { agent: a2, status: "idle" });
  await sleep(20);
  assert.equal(a2._sent.length, 1, "同一 turn/end 只能补一次");
  for (const c of ctx._cleanups) c();
});

test("重开后用户已自己发话 → 恢复时让位，不双发", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-user-took-over";
  const history = [abdResult(3, 50), turnEnd(3, TURN_END_SEQ)];

  const a1 = makeAgent(id, history);
  ctx.emit("agent/status", { agent: a1, status: "idle" });
  ctx.emit("agent/disposed", { agent: a1 });
  await sleep(20);
  assert.ok(lastEventOf(home, "rescue-pending"));

  // 重开后用户在恢复窗口里打了字（seq > turn/end seq）——真实 c5ee0860 里就是用户手打「继续」。
  const reopened = [...history, { type: "session/end-seed", seq: 105 }, userMsg(120, "user", "继续")];
  const a2 = makeAgent(id, reopened);
  ctx.emit("agent/status", { agent: a2, status: "idle" });
  await sleep(20);

  assert.equal(a2._sent.length, 0, "用户已接手，不许再补");
  assert.equal(lastEventOf(home, "rescue-deferred")?.why, "already-handled");
  for (const c of ctx._cleanups) c();
});

test("预算跨 close/reopen 存活：重开后同轮不再重复 plan", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-budget-kept";
  const history = [abdResult(1, 10), turnEnd(1, TURN_END_SEQ)];

  const a1 = makeAgent(id, history);
  ctx.emit("agent/status", { agent: a1, status: "idle" });
  ctx.emit("agent/disposed", { agent: a1 });
  await sleep(20);
  assert.ok(lastEventOf(home, "rescue-pending"));

  const a2 = makeAgent(id, history);
  ctx.emit("agent/status", { agent: a2, status: "idle" });
  await sleep(20);
  assert.equal(a2._sent.length, 1, "挂起的补发应送达新 agent");

  // 恢复后 onStatus 的 planRescue 不得二次调度（pendingSeq 占坑仍在）。
  assert.equal(
    logEvents(home).filter((e) => e.event === "rescue-scheduled").length,
    1,
    "同一 turn/end 只允许一次 plan",
  );
  for (const c of ctx._cleanups) c();
});

test("自己的补发不重置预算（SELF_SOURCE 排除），真人发话才重置", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-self-no-reset";
  const history = [abdResult(1, 10), turnEnd(1, TURN_END_SEQ)];
  const a = makeAgent(id, history);

  ctx.emit("agent/status", { agent: a, status: "idle" });
  await sleep(20);
  assert.equal(a._sent.length, 1, "先正常补一次");

  // 自己补发的 echo 进 inbox：预算绝不能清零（否则 continueMax 失效 → 无限补发）。
  ctx.emit("agent/inbox/inserted", {
    agent: a,
    message: { source: { kind: "dsh-abd-rescue" } },
  });
  const sentAfterSelf = a._sent.length;

  // 造一个新的异常轮次（turn 2），若预算被自己的 echo 清零，它还能再补；
  // 正确行为：turn 1 用掉 1/3，turn 2 还能补（预算未清零 = 正确？不对——）
  // 这里直接断言日志：SELF echo 不应产生 budget-reset。
  assert.equal(
    logEvents(home).filter((e) => e.event === "budget-reset").length,
    0,
    "自己的补发不得触发 budget-reset",
  );
  assert.equal(a._sent.length, sentAfterSelf, "SELF echo 不得产生任何补发");

  // 真人发话 → 预算清零。
  ctx.emit("agent/inbox/inserted", { agent: a, message: { source: { kind: "user" } } });
  assert.equal(logEvents(home).filter((e) => e.event === "budget-reset").length, 1, "真人发话应清零");
  for (const c of ctx._cleanups) c();
});

test("turn/end 变了 → 重查让位（turn-end-changed），不补", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-turn-changed";
  // 事件流会被追加：plan 时最后一条 turn/end 是 seq 100，fire 时变成 seq 200（另一轮已跑完）。
  const events = [abdResult(1, 98), turnEnd(1, TURN_END_SEQ)];
  const a = makeAgent(id, events);

  ctx.emit("agent/status", { agent: a, status: "idle" });
  assert.ok(lastEventOf(home, "rescue-scheduled"));

  // fire（0ms 定时器）触发前，同一轮被真人接手并跑出了新的一轮（正常完成）。
  events.push(userMsg(150, "user", "继续"), turnEnd(2, 200));

  await sleep(20);
  // 两个拦发机制都会在 turn-end-changed 之前或之后留痕：
  // hasFreshContinuation 先看到 seq 150 的真人消息 → already-handled；
  // 若没有该消息，turn-end-changed 也会拦。断言「没发出去」+「留痕」。
  assert.equal(a._sent.length, 0, "turn/end 已换一轮，不许补");
  const deferred = logEvents(home).filter((e) => e.event === "rescue-deferred" || e.event === "rescue-aborted");
  assert.ok(deferred.length >= 1, "拦发必须留痕");
  for (const c of ctx._cleanups) c();
});

test("dispose 后 onStatus 旧 agent 迟到的事件不再处理", async () => {
  const home = freshHome();
  const ctx = boot();
  const id = "sess-late-event";
  const history = [abdResult(2, 20), turnEnd(2, TURN_END_SEQ)];

  const a1 = makeAgent(id, history);
  ctx.emit("agent/status", { agent: a1, status: "idle" });
  assert.ok(lastEventOf(home, "rescue-scheduled"));
  ctx.emit("agent/disposed", { agent: a1 });
  await sleep(20);

  // 旧 agent 迟到的 idle 事件：deadAgents 拦截，不得再次 plan/挂起。
  ctx.emit("agent/status", { agent: a1, status: "idle" });
  await sleep(20);
  assert.equal(
    logEvents(home).filter((e) => e.event === "rescue-scheduled").length,
    1,
    "旧 agent 的迟到事件不应触发新的 plan",
  );
  for (const c of ctx._cleanups) c();
});
