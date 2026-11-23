/**
 * dsh-abd-rescue —— 「工具调用被拦在派发前」的救援插件。
 *
 * 只做一件事：轮次以**非用户原因**异常结束、且该轮里有工具调用收到
 * ABORTED_BEFORE_DISPATCH（「Error: tool call aborted before dispatch」）
 * → 自动补一条指向性的「继续」，让模型重新发起那个被拦下的调用。
 *
 * 为什么单独做一个插件（参考物：dsh-unstuck，本机 fork 在 ~/.dsh/repos/）：
 *   dsh-unstuck 的「问了不等」守卫会主动 cancel 它认为「问了你却没等回答就往下干」
 *   的轮次；被拦下的工具调用铸造 ABORTED_BEFORE_DISPATCH，用户看到满屏红色 ABD 错误。
 *   而它设计上**不给自己的暂停补继续**（isQuestionPauseAbort 排除 + suppressAutoContinue），
 *   于是每次守卫误报，用户都得手动打「继续」。
 *   本机全量审计（2026-11-22，tools/replay.mjs 可复现）：现存会话 43/43 个 ABD
 *   工具结果 = 守卫自掐，0 个真上游中断。本插件把这 43 类场景全部接住。
 *
 * 与 dsh-unstuck 共存的去重（两条，缺一不可）：
 *   1. 延迟差：本插件首发 delayMs + backoff[0] = 2500ms，比 unstuck 的 toolAbort
 *      首发 2200ms 晚 300ms。真上游 ABD（不是守卫自掐）时两边都想续，让 unstuck
 *      先开口，本插件发送前重查就会看到它补过 → 让位。
 *   2. 发送前重查（fireRescue）：turn/end 之后已出现「真人消息」或
 *      「continue-like 消息」（continue / dsh-unstuck / 自己）→ 不补。
 *      重查只认 kind === "user" 的真人消息（白名单），harness 自塞的
 *      time-context / skill-catalog 之类不算。
 *
 * 设计约束（从 dsh-unstuck 的注释里继承，别改回去）：
 *   - 续跑消息的 source.kind 必须是 dsh-abd-rescue 自己的：否则自己的补发被
 *     当成真人输入 → 预算被重置 → 无限补发循环。
 *   - 发送那一刻重新校验 status / inbox / 事件流，不能只信触发时的快照：
 *     2.5s 的延迟里用户可能已经接手。
 *   - 预算窗口：真人发话（inbox 或事件流）或轮次正常完成 → 清零；
 *     用完 continueMax（默认 3）→ 停手 + 通知，绝不无限补。
 *   - 会话关闭不取消补发（2026-11-23 线上漏发 c5ee0860 的修复）：
 *     fire 时 agent 已 dispose / 状态槽没了 → 不取消，挂起（rescue-pending），
 *     等同一 session 的新 agent 对象注册（onStatus/slot）后 resumeDelayMs 立即重发；
 *     发送前重查照样拦「用户重开后已自己发话」的情况，不会双发。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import * as core from "./core.js";
import { loadConfig, resolveDshHome } from "./config.js";

export const name = "dsh-abd-rescue";

/** 不声明 inject：少一个服务就 pending 卡住宿主，这里纯靠事件，不需要任何服务。 */
export const inject = [];

function sessionIdOf(agent) {
  return String(agent?.id || agent?.session?.id || "");
}

export function apply(ctx, config) {
  const dshHome = resolveDshHome();
  const cfg = loadConfig(config, dshHome);

  if (!cfg.enabled) {
    console.log("[dsh-abd-rescue] disabled by config, nothing installed");
    return;
  }

  const logDir = path.join(dshHome, "abd-rescue");
  const logFile = path.join(logDir, "abd-rescue.jsonl");

  function rotateIfNeeded() {
    try {
      const st = fs.statSync(logFile);
      if (st.size > cfg.logMaxBytes) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      /* 文件不存在就不用轮转 */
    }
  }

  function record(level, event, extra) {
    if (level !== "debug" || cfg.verbose) {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        level,
        event,
        ...(extra && typeof extra === "object" ? extra : {}),
      });
      try {
        fs.mkdirSync(logDir, { recursive: true });
        rotateIfNeeded();
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        /* 日志写不进去不能影响主流程 */
      }
      const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
      console.log(`[dsh-abd-rescue] ${event}${suffix}`);
    }
  }

  /** 需要人知道的事：写日志 + 可选跑一条命令（比如弹 Windows 通知）。 */
  function notify(event, extra, message) {
    record("warn", event, extra);
    if (!cfg.notifyCommand) return;
    try {
      const text = String(message || event).replace(/["'`\r\n]/g, " ");
      const cmd = cfg.notifyCommand.includes("{msg}")
        ? cfg.notifyCommand.split("{msg}").join(text)
        : `${cfg.notifyCommand} ${text}`;
      spawn(cmd, { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      record("error", "notify-command-failed", { err: String(e?.message || e) });
    }
  }

  /** sessionId → { agent, continues, lastRescueSeq, pendingSeq }。
   *  Map 插入序做 FIFO + 上限驱逐，防长开进程无限膨胀（与 dsh-unstuck 的
   *  createState(cap=200, evict=50) 同款）。 */
  const state = new Map();
  const STATE_CAP = 200;
  const STATE_EVICT = 50;
  const timers = new Set();

  /**
   * 挂起的补发：fire 时 agent 已 dispose（会话在发送窗口里被关闭）→
   * 不取消，记在这里，等同一 session 的新 agent 对象注册（onStatus）后
   * 重验重发。独立于状态槽存储：槽会被 cap 驱逐，挂起项不能跟着丢
   * （2026-11-23 c5ee0860 漏发的修复点）。
   */
  const pending = new Map(); // sessionId → { triggerSeq, abdCountAtPlan }
  const PENDING_CAP = 200;

  /**
   * 已经 disposed 的 agent 对象。记对象而不是记 id：同一个 session 被 resume
   * 出来是新 agent 对象，不受影响；旧对象迟到的 status 事件被丢掉。
   */
  const deadAgents = new WeakSet();

  function slot(agent, id) {
    let s = state.get(id);
    if (!s) {
      if (state.size >= STATE_CAP) {
        let i = 0;
        for (const key of state.keys()) {
          if (i >= STATE_EVICT) break;
          state.delete(key);
          i += 1;
        }
      }
      s = { agent: null, continues: 0, lastRescueSeq: 0, pendingSeq: "" };
      state.set(id, s);
    }
    s.agent = agent;
    return s;
  }

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        const r = fn();
        if (r && typeof r.catch === "function") {
          r.catch((e) => record("error", "timer-threw", { err: String(e?.message || e) }));
        }
      } catch (e) {
        record("error", "timer-threw", { err: String(e?.message || e) });
      }
    }, Math.max(0, Number(ms) || 0));
    timers.add(timer);
    return timer;
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  // ---------------------------------------------------------------- 决策

  /**
   * 一轮结束了：该不该补「继续」。
   * 判定全在 core.shouldRescue，这里只管预算与调度。
   */
  function planRescue(agent, id, info, abd) {
    if (!cfg.autoContinue) return;
    const decision = core.shouldRescue(info, abd.count);
    if (!decision.rescue) {
      if (info.abnormal) {
        record("info", "rescue-skipped", {
          session: id,
          turn: info.turn,
          why: decision.why,
          kind: info.kind,
          userAbort: info.userAbort,
          abdCount: abd.count,
        });
      }
      return;
    }
    const s = slot(agent, id);
    // 同一条 turn/end 只补一次：重复的 idle 事件可能在发送窗口内再次投递，
    // 只查 lastRescueSeq 不够（它发送时才写），plan 时先占坑。
    const dedupKey = info.seq || `turn:${info.turn}`;
    if (s.pendingSeq === dedupKey || s.lastRescueSeq === info.seq) return;
    if (s.continues >= cfg.continueMax) {
      notify(
        "rescue-budget-exhausted",
        { session: id, turn: info.turn, continues: s.continues, abdCount: abd.count },
        `dsh 会话 ${id.slice(0, 8)} 连续 ${s.continues} 次出现「工具调用被拦在派发前」，救援已停手，需要人工看一眼`,
      );
      return;
    }
    const delay = cfg.delayMs + core.backoffFor(s.continues, cfg.backoffMs);
    s.pendingSeq = dedupKey;
    record("info", "rescue-scheduled", {
      session: id,
      turn: info.turn,
      abdCount: abd.count,
      attempt: s.continues + 1,
      delayMs: delay,
    });
    later(() => fireRescue(agent, id, info.seq, abd.count), delay);
  }

  /**
   * 真正发「继续」的那一刻，把所有前置条件重新验一遍。
   * 任何一条前置失败都必须留痕（rescue-aborted + why）：2026-11-23 线上漏发
   * （c5ee0860 turn 7）就是静默 return 造成的——scheduled 之后没有任何
   * 日志，无法定位。旧 agent 被 dispose 不是拦发理由：会话 resume 后
   * s.agent 已是新对象，闭包里的旧对象 dead 属正常，只查 live。
   */
  function fireRescue(agent, id, triggerSeq, abdCountAtPlan) {
    let s = state.get(id);
    if (!s && !deadAgents.has(agent)) {
      // 状态槽被 cap 驱逐但 agent 还活着：重建后继续（预算计数归零，
      // 语义可接受——被驱逐意味着该会话很久没活动）。
      s = slot(agent, id);
    }
    if (!s) {
      record("info", "rescue-aborted", { session: id, why: "state-gone" });
      return;
    }
    // 窗口里会话可能 resume 换了 agent 对象：onStatus 已把新的记到
    // s.agent，读状态 / 发 followup 都要用新对象。
    const live = s.agent || agent;
    if (deadAgents.has(live)) {
      // 会话在发送窗口里被关闭（agent 已 dispose，尚无新 agent 注册）。
      // 不取消：挂起，等 onStatus 看到同一 session 的新 agent 后重验重发
      // （rescue-resumed）。独立 pending 表 + cap，与状态槽的驱逐解耦。
      if (pending.size >= PENDING_CAP) {
        const evicted = pending.keys().next().value;
        pending.delete(evicted);
        record("warn", "rescue-pending-evicted", { session: evicted });
      }
      pending.set(id, { triggerSeq, abdCountAtPlan });
      record("info", "rescue-pending", {
        session: id,
        triggerSeq,
        abdCountAtPlan,
        why: "agent-disposed",
      });
      return;
    }
    if (live.status === "running") {
      record("info", "rescue-deferred", { session: id, why: "still-running" });
      return;
    }
    if (core.inboxBusy(live)) {
      record("info", "rescue-deferred", { session: id, why: "inbox-busy" });
      return;
    }
    const events = core.sessionEventsOf(live);
    const fresh = core.hasFreshContinuation(events);
    if (fresh.fresh) {
      // 用户接管，或者 dsh-unstuck / 桌面端按钮已经补过了 → 让位。
      // 有别人接手 = 这条会话有人管，预算清零（与 onInboxInserted 同语义）；
      // 排除自己的 kind：自己的补发不算「有人接管」，否则预算永远清零。
      if (fresh.byKind !== core.SELF_SOURCE) s.continues = 0;
      record("info", "rescue-deferred", { session: id, why: "already-handled", byKind: fresh.byKind });
      return;
    }
    // 快照可能过期：turn/end 换了一条、或 ABD 数量变了，重新判定。
    const info = core.inspectTurnEnd(events);
    if (info.seq !== triggerSeq) {
      record("info", "rescue-aborted", {
        session: id,
        why: "turn-end-changed",
        triggerSeq,
        nowSeq: info.seq,
      });
      return;
    }
    const abd = core.abdCountInLastTurn(events);
    const decision = core.shouldRescue(info, abd.count);
    if (!decision.rescue) {
      record("info", "rescue-skipped", { session: id, turn: info.turn, why: decision.why });
      return;
    }
    if (s.continues >= cfg.continueMax) {
      record("info", "rescue-aborted", {
        session: id,
        why: "budget-used-at-fire",
        continues: s.continues,
      });
      return;
    }

    try {
      live.followup(core.makeRescueMessage(cfg.continueText, `${core.SELF_SOURCE}-${randomUUID()}`));
    } catch (e) {
      record("error", "rescue-failed", { session: id, err: String(e?.message || e) });
      return;
    }
    s.continues += 1;
    s.lastRescueSeq = info.seq;
    record("info", "rescue-sent", {
      session: id,
      turn: info.turn,
      attempt: s.continues,
      kind: info.kind,
      abdCount: abd.count,
      abdCountAtPlan,
      text: cfg.continueText,
    });
  }

  // ---------------------------------------------------------------- 事件

  function onStatus(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    if (deadAgents.has(agent)) return;
    const id = sessionIdOf(agent);
    if (!id) return;
    if (cfg.skipOwnedAgents && core.looksOwned(agent)) return;
    const s = slot(agent, id);

    // 挂起的补发接回来：会话重开（新 agent 对象注册）→ 用新 agent 重验重发。
    // 重走 fireRescue 全套重查：如果用户在重开后已自己发话 / 别的插件已补，
    // hasFreshContinuation / turn-end-changed 会拦下，不会双发。
    // 新延迟 = resumeDelayMs（给 resume 事件流落盘留余量），不算进退避表。
    const held = pending.get(id);
    if (held) {
      pending.delete(id);
      record("info", "rescue-resumed", {
        session: id,
        triggerSeq: held.triggerSeq,
        abdCountAtPlan: held.abdCountAtPlan,
        delayMs: cfg.resumeDelayMs,
      });
      later(() => fireRescue(agent, id, held.triggerSeq, held.abdCountAtPlan), cfg.resumeDelayMs);
    }

    if (payload.status === "running") {
      record("debug", "running", { session: id });
      return;
    }

    // 非 running = 一轮结束了。不假设具体字面量（'idle' 之外还有其它终态），
    // 与 dsh-unstuck 的口径一致。
    const events = core.sessionEventsOf(agent);
    const info = core.inspectTurnEnd(events);
    if (!info.reason) return;
    // 正常完成 / 阻塞 / 分叉：活已了结，预算清零。
    if (!info.abnormal) {
      if (s.continues > 0) {
        record("info", "budget-reset", { session: id, why: "settled-turn", continues: s.continues });
      }
      s.continues = 0;
      return;
    }
    const abd = core.abdCountInLastTurn(events);
    planRescue(agent, id, info, abd);
  }

  /**
   * 有人往 inbox 塞了「接手」的消息 = 用户接管，预算立刻清零。
   * 认两类：真人（kind === "user"），以及别的接手者（桌面端「继续」按钮的
   * kind "continue"、dsh-unstuck 的补发）——但排除自己（SELF_SOURCE），
   * 否则自己的补发会重置自己的预算 → continueMax 失效 → 无限补发。
   * 注意：桌面端按钮不会进 inbox 的 kind==="user"，只认 user 会漏掉它。
   */
  function onInboxInserted(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    const kind = payload?.message?.source?.kind;
    const takeover =
      core.isHumanSourceKind(kind) ||
      (core.isContinueLikeKind(kind) && kind !== core.SELF_SOURCE);
    if (!takeover) return;
    const id = sessionIdOf(agent);
    const s = state.get(id);
    if (s && s.continues > 0) {
      record("info", "budget-reset", { session: id, why: `takeover-${String(kind)}`, continues: s.continues });
      s.continues = 0;
    }
  }

  function onDisposed(payload) {
    const agent = payload?.agent;
    if (agent && typeof agent === "object") deadAgents.add(agent);
    // 不再删状态槽：会话被关后重开是新 agent 对象、同一 session id，
    // 预算与挂起的补发要跨 close/reopen 存活（2026-11-23 c5ee0860 漏发修复：
    // 旧实现 state.delete 让 fire 时 slot 消失 → 静默 return）。
    // 槽由 cap 驱逐和插件 dispose 回收，不会无限膨胀。
  }

  // ---------------------------------------------------------------- 装配

  ctx.effect(() => {
    const offs = [
      listen("agent/status", onStatus),
      listen("agent/inbox/inserted", onInboxInserted),
      listen("agent/disposed", onDisposed),
    ];

    record("info", "boot", {
      home: dshHome,
      autoContinue: cfg.autoContinue,
      continueMax: cfg.continueMax,
      continueText: cfg.continueText,
      delayMs: cfg.delayMs,
      backoffMs: cfg.backoffMs,
      resumeDelayMs: cfg.resumeDelayMs,
      firstSendAtMs: cfg.delayMs + core.backoffFor(0, cfg.backoffMs),
      listeners: offs.filter(Boolean).length,
      configFile: path.join(logDir, "config.json"),
    });

    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      state.clear();
      pending.clear();
      for (const off of offs) {
        try {
          if (typeof off === "function") off();
        } catch {
          /* 忽略 */
        }
      }
      record("info", "dispose", {});
    };
  });
}

const plugin = { name, inject, apply };

export default plugin;
