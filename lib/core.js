/**
 * dsh-abd-rescue 纯逻辑层。
 *
 * 不 import cordis，不碰定时器/文件系统，只做「看事件、判状态、算退避」，
 * 方便 node --test 直接单测。副作用（发消息、日志、定时器）都在 index.js。
 *
 * 职责单一：轮次以**非用户原因**异常结束、且该轮里有工具调用被
 * ABORTED_BEFORE_DISPATCH 拦下 → 该补一条指向性的「继续」。
 * 其它一切（正常完成、你按的停止、没有 ABD 的轮次）一律不碰。
 *
 * 事件形状取自本机真实会话日志（2026-11-22 全量审计，43 例）：
 *   ABD 工具结果：
 *     {"type":"tool/result","seq":471,
 *      "data":{"turn":1,"step":70,
 *              "message":{"role":"tool",...,"content":[{"type":"text",
 *                "text":"Error: tool call aborted before dispatch"}],"isError":true},
 *              "error":{"name":"AbortError","code":"ABORTED_BEFORE_DISPATCH"}}}
 *   守卫自掐的轮次结尾：
 *     {"type":"turn/end","data":{"turn":1,
 *      "reason":{"kind":"aborted","reason":{"kind":"hook",
 *              "reason":"unstuck-unanswered-question"}}}}
 */

/** 我们自己注入的消息 source.kind。必须是自己的、不是 "user"：
 *  否则自己的补发会被当成真人输入，重置预算后无限补发。 */
export const SELF_SOURCE = "dsh-abd-rescue";

/** 调度器铸造「工具调用被拦在派发前」错误时用的 code。 */
export const ABD_CODE = "ABORTED_BEFORE_DISPATCH";

/** ABD 错误的正文指纹（code 字段缺失时的兜底识别）。 */
export const ABD_TEXT_FINGERPRINT = "tool call aborted before dispatch";

/** 只有 kind === "user" 是真人打的字。
 *  用白名单而不是黑名单：user/message 的 source.kind 实测有十几种，
 *  全是 harness 自己塞的上下文（time-context / skill-catalog / runtime-context…），
 *  认错会让预算永远被重置，等于没有上限。 */
export const HUMAN_SOURCE_KINDS = new Set(["user"]);

/** 已经有人接手了：桌面端「继续」按钮（kind "continue"）、dsh-unstuck、
 *  我们自己的补发。看到这些就别再补一条，免得一轮变两条。 */
export const CONTINUE_LIKE_KINDS = new Set([
  "continue",
  SELF_SOURCE,
  "dsh-unstuck",
  "dsh-supervisor", // dsh-unstuck 改名前留下的 kind
]);

/** 值得补发的 turn/end 原因。completed / blocked / forked 一律不动。 */
export const ABNORMAL_KINDS = ["error", "aborted", "max-tokens", "interrupted"];

/**
 * 上下文溢出码：这类轮次 dsh-unstuck 走 overflow handoff（同 workspace 新建会话续跑），
 * 原会话不插任何消息。本插件若同时补发，会与正在搬家的会话撞车 —— 让位给它。
 * 与 dsh-unstuck 的 OVERFLOW_CODES 对齐（单一事实源在那边，这里只能抄一份）。
 */
export const OVERFLOW_CODES = ["CONTEXT_OVERFLOW", "CONTEXT_LENGTH", "CONTEXT_WINDOW_EXCEEDED"];

/** 失败 code，大小写无关地归一。 */
export function failureCodeOf(reason) {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code;
  return String(raw || "").toUpperCase();
}

/** 这条消息是真人打的吗？ */
export function isHumanSourceKind(kind) {
  return HUMAN_SOURCE_KINDS.has(String(kind || ""));
}

/** 这条消息是不是「已经有人让他继续」？ */
export function isContinueLikeKind(kind) {
  return CONTINUE_LIKE_KINDS.has(String(kind || ""));
}

/** turn/end 里 aborted 的 cause 形状：字符串或 { kind }。 */
export function causeKindOf(reason) {
  const cause = reason?.reason;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object" && typeof cause.kind === "string") return cause.kind;
  return "";
}

/** 是不是「用户自己按了停止」。这类中断绝不补发，否则会跟用户抢。 */
export function isUserAbort(reason) {
  if (!reason || reason.kind !== "aborted") return false;
  const kind = causeKindOf(reason);
  return kind === "user" || kind === "cancel";
}

/**
 * 这条事件是不是「工具调用被拦在派发前」的结果。
 * 优先信结构化 code（宿主铸造点 dsh-tools batch.js skip() 把 error.info 平铺到
 * data 顶层，实测形状 data.error.code；旧路径 message.error.info.code 也查，
 * 与 dsh-unstuck 的 abdCodeAt 同款）；code 全缺时退回正文指纹。
 */
export function isAbortedBeforeDispatch(event) {
  if (!event || event.type !== "tool/result") return false;
  const data = event.data || {};
  const codes = [data?.error?.code, data?.message?.error?.info?.code];
  if (codes.some((c) => String(c || "").toUpperCase() === ABD_CODE)) return true;
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  return blocks.some(
    (b) =>
      b?.type === "text" &&
      String(b.text || "").includes(ABD_TEXT_FINGERPRINT),
  );
}

/** 从后往前找最后一条 turn/end。 */
export function lastTurnEnd(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") return list[i];
  }
  return null;
}

/** 把最后一条 turn/end 折成判断用的摘要。 */
export function inspectTurnEnd(events) {
  const end = lastTurnEnd(events);
  const reason = end?.data?.reason || null;
  return {
    seq: end?.seq || 0,
    turn: end?.data?.turn || 0,
    reason,
    kind: reason?.kind || "",
    userAbort: isUserAbort(reason),
    abnormal: Boolean(reason && ABNORMAL_KINDS.includes(reason.kind)),
  };
}

/**
 * 最后一个轮次里，有几个工具调用被 ABD 拦下。
 * 返回 { count, seqs }；没有 turn/end 时返回零。
 */
export function abdCountInLastTurn(events) {
  const end = lastTurnEnd(events);
  const turn = end?.data?.turn;
  if (turn === undefined || turn === null) return { count: 0, seqs: [] };
  const seqs = (Array.isArray(events) ? events : [])
    .filter((e) => e?.type === "tool/result" && e.data?.turn === turn && isAbortedBeforeDispatch(e))
    .map((e) => e.seq || 0);
  return { count: seqs.length, seqs };
}

/**
 * 该不该补发。纯判定，不带副作用。
 * 顺序有讲究：先排除（用户停止 / disposed / 正常结束），再看有没有 ABD。
 */
export function shouldRescue(info, abdCount) {
  if (!info || !info.reason) return { rescue: false, why: "no-turn-end" };
  if (causeKindOf(info.reason) === "disposed") return { rescue: false, why: "disposed" };
  if (info.userAbort) return { rescue: false, why: "user-abort" };
  if (!info.abnormal) return { rescue: false, why: "not-abnormal" };
  if (OVERFLOW_CODES.includes(failureCodeOf(info.reason))) {
    return { rescue: false, why: "overflow-handoff" };
  }
  if (!abdCount || abdCount <= 0) return { rescue: false, why: "no-abd" };
  return { rescue: true, why: "abd" };
}

/**
 * 最后一条 turn/end 之后，有没有人已经接手了这一轮 —— 真人发话，或者
 * 别的插件 / 桌面端按钮已经补过一条「继续」。
 *
 * 这是发送前重查的判据：dsh-unstuck 的 toolAbort 路径对**真上游** ABD
 * 也会补「继续」，两边延迟接近，让位规则 = 它先开口我就闭嘴。
 */
export function hasFreshContinuation(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  const after = end ? list.filter((event) => (event?.seq || 0) > end.seq) : list;
  for (const event of after) {
    if (event?.type !== "user/message") continue;
    const kind = event.data?.source?.kind;
    if (isHumanSourceKind(kind)) return { fresh: true, byKind: "human" };
    if (isContinueLikeKind(kind)) return { fresh: true, byKind: String(kind || "continue") };
  }
  return { fresh: false, byKind: "" };
}

/** 第 n 次补发前等多久：查表，超出就取最后一档。 */
export function backoffFor(index, table) {
  const list = Array.isArray(table) && table.length > 0 ? table : [1500];
  const i = Math.max(0, Math.min(list.length - 1, Math.trunc(Number(index) || 0)));
  const value = Number(list[i]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 补发消息。source.kind 必须是自己的（见 SELF_SOURCE 注释）。 */
export function makeRescueMessage(text, id) {
  const body = String(text || "继续").trim() || "继续";
  return {
    id: id || `${SELF_SOURCE}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: {
      kind: SELF_SOURCE,
      form: "notice",
      summary: "abd-rescue",
    },
  };
}

/** 取 agent 的会话事件快照，各种实现都兜一下。 */
export function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch {
    /* 换下一种 */
  }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch {
    /* 没有就没有 */
  }
  return [];
}

/** inbox 里还有没排队的活（排队中就别再塞「继续」）。 */
export function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox;
    if (!inbox) return false;
    if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return true;
    if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return true;
    if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
  } catch {
    /* 结构不认识就当不忙 */
  }
  return false;
}

/** 子 agent（被别的 agent 托管的）默认不插手。 */
export function looksOwned(agent) {
  try {
    if (agent?.parent || agent?.owner || agent?.ownedBy) return true;
    const session = agent?.session;
    if (session?.parentSessionId || session?.parent) return true;
  } catch {
    /* 忽略 */
  }
  return false;
}
