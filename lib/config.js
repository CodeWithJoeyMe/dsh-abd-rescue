/**
 * dsh-abd-rescue 配置：默认值 + 归一化 + 用户覆盖文件。
 *
 * 三层覆盖（后者赢）：内置默认 → cordis.patch.yml 里的 config → <dshHome>/abd-rescue/config.json
 * 这样调参不用改 patch、不用重启也能改文件后等下次 apply。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  verbose: false,

  /** 总开关：检测到「异常结束 + ABD」时自动补一条「继续」。 */
  autoContinue: true,
  /** 每个会话（预算窗口）最多补几次，用完就停手并通知。 */
  continueMax: 3,
  /** 补发文案。与 dsh-unstuck 的 toolAbortContinueText 保持一致。 */
  continueText: "继续。刚才的工具调用被中断，请重试",
  /**
   * 基础延迟：发现该补之后先等这么久再发，让 turn/end 落盘。
   * 首发总延迟 = delayMs + backoffMs[0]，默认 1000 + 1500 = 2500ms，
   * 故意比 dsh-unstuck 的 toolAbort 首发（700 + 1500 = 2200ms）略晚：
   * 真上游 ABD 两边都想续时，让它先开口，本插件发送前重查就自动让位。
   */
  delayMs: 1000,
  /** 第 1/2/3… 次补发前的额外退避，防止把上游打爆。 */
  backoffMs: [1500, 5000, 15000],

  /** 子 agent（被托管）默认不插手，免得跟 subagent 框架打架。 */
  skipOwnedAgents: true,

  /**
   * 会话关闭→重开（agent 换对象）时，挂起的补发在新 agent 注册后等多久再重验重发。
   * 给 resume 的事件流落盘留一点余量；发送前重查会拦掉「用户重开后已自己发话」。
   */
  resumeDelayMs: 500,

  /** 需要人知道的事额外执行的命令，{msg} 会被替换成正文。留空则只写日志。 */
  notifyCommand: "",
  /** 日志超过这个大小就轮转成 .1。 */
  logMaxBytes: 5 * 1024 * 1024,
});

export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value !== false && value !== 0 && value !== "false";
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_CONFIG;
  const backoff = Array.isArray(src.backoffMs)
    ? src.backoffMs.map((v) => clampInt(v, 0, 0, 600000))
    : [...d.backoffMs];
  return {
    enabled: asBool(src.enabled, d.enabled),
    verbose: asBool(src.verbose, d.verbose),

    autoContinue: asBool(src.autoContinue, d.autoContinue),
    continueMax: clampInt(src.continueMax, d.continueMax, 0, 50),
    continueText:
      typeof src.continueText === "string" && src.continueText.trim()
        ? src.continueText.trim()
        : d.continueText,
    delayMs: clampInt(src.delayMs, d.delayMs, 0, 600000),
    backoffMs: backoff.length > 0 ? backoff : [...d.backoffMs],

    skipOwnedAgents: asBool(src.skipOwnedAgents, d.skipOwnedAgents),

    resumeDelayMs: clampInt(src.resumeDelayMs, d.resumeDelayMs, 0, 600000),

    notifyCommand: typeof src.notifyCommand === "string" ? src.notifyCommand.trim() : d.notifyCommand,
    logMaxBytes: clampInt(src.logMaxBytes, d.logMaxBytes, 65536, 512 * 1024 * 1024),
  };
}

/** $DSH_HOME，找不到就退回 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  const home = os.homedir();
  const direct = path.join(home, ".dsh");
  try {
    if (fs.existsSync(direct)) return direct;
  } catch {
    /* 忽略 */
  }
  return direct;
}

export function userConfigPath(dshHome) {
  return path.join(dshHome, "abd-rescue", "config.json");
}

/** 读用户覆盖配置；坏了就当没有，别让救援插件把 dsh 拖死。 */
export function readUserConfig(dshHome) {
  try {
    const fp = userConfigPath(dshHome);
    if (!fs.existsSync(fp)) return {};
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    // 配置坏了静默回落默认值会掩盖问题，给宿主控制台留一行。
    console.warn(`[dsh-abd-rescue] 用户配置读取失败，已用默认值: ${String(e?.message || e)}`);
    return {};
  }
}

/** 插件 config + 用户文件 → 最终配置。 */
export function loadConfig(pluginConfig, dshHome) {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...(pluginConfig || {}), ...readUserConfig(dshHome) });
}
