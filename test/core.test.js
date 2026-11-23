/**
 * dsh-abd-rescue 纯逻辑层单测（node --test）。
 * 用例取自本机真实会话日志（2026-11-22 审计），形状见 lib/core.js 头注。
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as core from "../lib/core.js";

const GUARD_REASON = { kind: "aborted", reason: { kind: "hook", reason: "unstuck-unanswered-question" } };
const USER_REASON = { kind: "aborted", reason: { kind: "user" } };
const STRING_USER_REASON = { kind: "aborted", reason: "user" };
const COMPLETED_REASON = { kind: "completed" };
const API_ERROR_REASON = { kind: "error", error: { code: "RATE_LIMIT" } };

function abdResult(turn, step, seq, { code = true, text = true } = {}) {
  const blocks = [];
  if (text) blocks.push({ type: "text", text: "Error: tool call aborted before dispatch" });
  return {
    type: "tool/result",
    seq,
    data: {
      turn,
      step,
      message: { role: "tool", content: blocks, isError: true },
      ...(code ? { error: { name: "AbortError", code: "ABORTED_BEFORE_DISPATCH" } } : {}),
    },
  };
}

function turnEnd(turn, seq, reason) {
  return { type: "turn/end", seq, data: { turn, reason } };
}

function userMsg(seq, kind, text = "x") {
  // 真实事件形状：正文在 data.content（实测 keys: content,source,role,id）。
  return {
    type: "user/message",
    seq,
    data: { content: [{ type: "text", text }], source: { kind }, role: "user" },
  };
}

test("isAbortedBeforeDispatch：旧宿主路径 message.error.info.code 也认", () => {
  const e = {
    type: "tool/result",
    seq: 5,
    data: { turn: 1, message: { content: [], error: { info: { code: "aborted_before_dispatch" } } } },
  };
  assert.equal(core.isAbortedBeforeDispatch(e), true);
});

test("isAbortedBeforeDispatch：认 code 字段", () => {
  assert.equal(core.isAbortedBeforeDispatch(abdResult(1, 5, 100)), true);
});

test("isAbortedBeforeDispatch：code 缺失时认正文指纹", () => {
  assert.equal(core.isAbortedBeforeDispatch(abdResult(1, 5, 100, { code: false, text: true })), true);
  assert.equal(core.isAbortedBeforeDispatch(abdResult(1, 5, 100, { code: false, text: false })), false);
});

test("isAbortedBeforeDispatch：其它事件 / 其它错误不算", () => {
  assert.equal(core.isAbortedBeforeDispatch({ type: "tool/result", seq: 1, data: { turn: 1, error: { code: "TIMEOUT" } } }), false);
  assert.equal(core.isAbortedBeforeDispatch({ type: "assistant/message", seq: 2, data: {} }), false);
  assert.equal(core.isAbortedBeforeDispatch(null), false);
});

test("isUserAbort：user / cancel 算，守卫自掐不算", () => {
  assert.equal(core.isUserAbort(USER_REASON), true);
  assert.equal(core.isUserAbort(STRING_USER_REASON), true);
  assert.equal(core.isUserAbort(GUARD_REASON), false);
  assert.equal(core.isUserAbort(COMPLETED_REASON), false);
  assert.equal(core.isUserAbort(null), false);
});

test("causeKindOf：字符串与对象两种形状", () => {
  assert.equal(core.causeKindOf(USER_REASON), "user");
  assert.equal(core.causeKindOf(GUARD_REASON), "hook");
  assert.equal(core.causeKindOf(COMPLETED_REASON), "");
});

test("abdCountInLastTurn：只数最后一个 turn 里的", () => {
  const events = [
    abdResult(1, 3, 10),
    turnEnd(1, 11, GUARD_REASON),
    userMsg(12, "user", "继续"),
    abdResult(2, 4, 20),
    abdResult(2, 5, 21),
    turnEnd(2, 22, GUARD_REASON),
  ];
  assert.deepEqual(core.abdCountInLastTurn(events), { count: 2, seqs: [20, 21] });
  const noEnd = [abdResult(1, 3, 10)];
  assert.deepEqual(core.abdCountInLastTurn(noEnd), { count: 0, seqs: [] });
});

test("shouldRescue：守卫自掐 + 有 ABD → 补", () => {
  const info = core.inspectTurnEnd([turnEnd(1, 1, GUARD_REASON)]);
  assert.deepEqual(core.shouldRescue(info, 2), { rescue: true, why: "abd" });
});

test("shouldRescue：用户按停 → 不补（哪怕有 ABD）", () => {
  const info = core.inspectTurnEnd([turnEnd(1, 1, USER_REASON)]);
  assert.deepEqual(core.shouldRescue(info, 3), { rescue: false, why: "user-abort" });
});

test("shouldRescue：正常完成 → 不补", () => {
  const info = core.inspectTurnEnd([turnEnd(1, 1, COMPLETED_REASON)]);
  assert.deepEqual(core.shouldRescue(info, 3), { rescue: false, why: "not-abnormal" });
});

test("shouldRescue：异常结束但没有 ABD → 不补", () => {
  const info = core.inspectTurnEnd([turnEnd(1, 1, API_ERROR_REASON)]);
  assert.deepEqual(core.shouldRescue(info, 0), { rescue: false, why: "no-abd" });
});

test("shouldRescue：disposed → 不补；没有 turn/end → 不补", () => {
  const disposed = { seq: 1, turn: 1, reason: { kind: "aborted", reason: "disposed" }, kind: "aborted", userAbort: false, abnormal: true };
  assert.deepEqual(core.shouldRescue(disposed, 1), { rescue: false, why: "disposed" });
  assert.deepEqual(core.shouldRescue(core.inspectTurnEnd([]), 1), { rescue: false, why: "no-turn-end" });
});

test("shouldRescue：上下文溢出码 → 让位给 unstuck 的 overflow handoff", () => {
  for (const code of ["CONTEXT_OVERFLOW", "CONTEXT_LENGTH", "CONTEXT_WINDOW_EXCEEDED"]) {
    const info = core.inspectTurnEnd([turnEnd(1, 1, { kind: "error", error: { code } })]);
    assert.deepEqual(core.shouldRescue(info, 2), { rescue: false, why: "overflow-handoff" }, code);
  }
});

test("hasFreshContinuation：真人 / continue-like 算接手，harness 自塞不算", () => {
  const base = [turnEnd(1, 1, GUARD_REASON)];
  assert.deepEqual(core.hasFreshContinuation(base), { fresh: false, byKind: "" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, "time-context")]), { fresh: false, byKind: "" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, "skill-catalog")]), { fresh: false, byKind: "" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, "user", "继续")]), { fresh: true, byKind: "human" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, "dsh-unstuck")]), { fresh: true, byKind: "dsh-unstuck" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, "continue")]), { fresh: true, byKind: "continue" });
  assert.deepEqual(core.hasFreshContinuation([...base, userMsg(2, core.SELF_SOURCE)]), { fresh: true, byKind: core.SELF_SOURCE });
  // 没有 turn/end 时看全部事件
  assert.deepEqual(core.hasFreshContinuation([userMsg(2, "user")]), { fresh: true, byKind: "human" });
});

test("backoffFor：查表、越界取最后一档、坏值当 0", () => {
  assert.equal(core.backoffFor(0, [1500, 5000, 15000]), 1500);
  assert.equal(core.backoffFor(2, [1500, 5000, 15000]), 15000);
  assert.equal(core.backoffFor(9, [1500, 5000, 15000]), 15000);
  assert.equal(core.backoffFor(0, []), 1500);
  assert.equal(core.backoffFor(0, [null, 5000]), 0);
});

test("makeRescueMessage：source.kind 必须是自己的", () => {
  const m = core.makeRescueMessage("继续。刚才的工具调用被中断，请重试", "test-id");
  assert.equal(m.id, "test-id");
  assert.equal(m.role, "user");
  assert.equal(m.source.kind, "dsh-abd-rescue");
  assert.equal(m.content[0].text, "继续。刚才的工具调用被中断，请重试");
  const d = core.makeRescueMessage("   ");
  assert.equal(d.content[0].text, "继续");
  assert.match(d.id, /^dsh-abd-rescue-\d+-/);
});

test("sessionEventsOf：三种来源都兜", () => {
  const evs = [turnEnd(1, 1, COMPLETED_REASON)];
  assert.deepEqual(core.sessionEventsOf({ session: { snapshotEvents: () => evs } }), evs);
  assert.deepEqual(core.sessionEventsOf({ session: { events: evs } }), evs);
  assert.deepEqual(core.sessionEventsOf({ session: {} }), []);
  assert.deepEqual(core.sessionEventsOf({}), []);
  // snapshotEvents 抛错时退回 events
  assert.deepEqual(
    core.sessionEventsOf({ session: { snapshotEvents: () => { throw new Error("x"); }, events: evs } }),
    evs,
  );
});

test("inboxBusy / looksOwned", () => {
  assert.equal(core.inboxBusy({ inbox: { nextTurn: [], nextStep: [] } }), false);
  assert.equal(core.inboxBusy({ inbox: { nextTurn: [1], nextStep: [] } }), true);
  assert.equal(core.inboxBusy({ inbox: { nextTurn: [], nextStep: [], hasPending: () => true } }), true);
  assert.equal(core.inboxBusy({}), false);
  assert.equal(core.inboxBusy({ inbox: { get nextTurn() { throw new Error("x"); } } }), false);
  assert.equal(core.looksOwned({}), false);
  assert.equal(core.looksOwned({ parent: {} }), true);
  assert.equal(core.looksOwned({ session: { parentSessionId: "p" } }), true);
});

test("isHumanSourceKind / isContinueLikeKind：白名单", () => {
  assert.equal(core.isHumanSourceKind("user"), true);
  assert.equal(core.isHumanSourceKind("time-context"), false);
  assert.equal(core.isContinueLikeKind("continue"), true);
  assert.equal(core.isContinueLikeKind("dsh-unstuck"), true);
  assert.equal(core.isContinueLikeKind("dsh-supervisor"), true);
  assert.equal(core.isContinueLikeKind("dsh-abd-rescue"), true);
  assert.equal(core.isContinueLikeKind("user"), false);
});
