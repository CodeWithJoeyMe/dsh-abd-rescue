# dsh-abd-rescue

DeepSeek Harness (DSH) 救援插件：**轮次被异常结束（不是你按的停止），且该轮里有工具调用被「tool call aborted before dispatch」(ABORTED_BEFORE_DISPATCH, ABD) 拦下 → 自动补一条指向性的「继续」**，让模型重新发起那个被拦下的调用。

## 为什么需要它

`dsh-unstuck` 的「问了不等」守卫会主动 cancel 它认为「问了你却没等回答就往下干」的轮次。被拦下的工具调用会在调度器那里铸造 `Error: tool call aborted before dispatch`，你在界面上看到满屏红色 ABD 错误卡片。而 dsh-unstuck 设计上**不给自己的暂停补继续**（`isQuestionPauseAbort` 排除 + `suppressAutoContinue` 抑制）——所以每次守卫误报（它确实会误报：引用文本里的「点头」、自述的「确认一下」、复述你的「拍板」都会命中它的标记词），你都得手动打一句「继续」。

**本机全量审计（2026-11-22，354 个会话文件，`node tools/replay.mjs` 可复现）**：现存日志里 70 个含 ABD 工具的轮次中，59 个是守卫自掐、7 个工具被拦但轮次最终正常完成、2 个上游 error 伴随 ABD、2 个已关闭/老格式会话（无 turn/end，活体不可救）。其中 49 个轮次你事后都手动发了「继续」。本插件把 61 个「异常结束 + ABD」的轮次全部接住，剩下 9 个（已正常完成 / 已关闭会话）正确地不碰。

## 行为

| 情况 | 动作 |
|---|---|
| 轮次以非用户原因的 `aborted` / `error` / `max-tokens` / `interrupted` 结束，且该轮有 ABD 工具结果 | 补「继续。刚才的工具调用被中断，请重试」 |
| 你按的停止（`aborted{kind:'user'}`） | 不碰 |
| 工具被拦但轮次最终正常 completed | 不碰（调用已取消、模型已换路走完，补发反而怂恿重试） |
| 上下文溢出码（CONTEXT_OVERFLOW 等） | 不碰（dsh-unstuck 走 overflow handoff 新建会话续跑，原会话不插消息） |
| 会话在发送窗口内被关闭（agent disposed） | 挂起重发：等同一 session 重开（新 agent 注册）后 `resumeDelayMs` 重验补发；你重开后已自己发话则让位（2026-11-23 c5ee0860 漏发修复） |
| 每会话补发满 `continueMax`（默认 3） | 停手 + 写日志通知 |
| 真人发话，或桌面端「继续」按钮 / dsh-unstuck 接手 | 预算清零 |

## 与 dsh-unstuck 共存的去重

两边都想续「真上游 ABD」时会撞车，两条规则保证一轮只补一条：

1. **延迟差**：本插件首发 `delayMs + backoffMs[0]` = 2500ms，比 dsh-unstuck 的 toolAbort 首发 2200ms 晚 300ms → 让它先开口。
2. **发送前重查**：turn/end 之后已出现真人消息，或 `continue` / `dsh-unstuck` / 自己发过的 continue-like 消息 → 让位。只认白名单 kind（`user` 是真人；`time-context` / `skill-catalog` 等 harness 自塞的不算）。

## 安装

```powershell
cd $env:USERPROFILE\.dsh\repos\dsh-abd-rescue
pwsh -File .\install.ps1          # 默认装进 desktop profile
```

完全退出并重启 DeepSeek Harness 后生效。验证：

```powershell
Get-Content "$env:USERPROFILE\.dsh\abd-rescue\abd-rescue.jsonl" -Tail 20
# 看到 {"event":"boot"} 就是装好了；每次补发记一条 rescue-sent
```

卸载：`pwsh -File .\uninstall.ps1` 后重启。

## 配置

三层覆盖（后者赢）：内置默认 → `cordis.patch.yml` 里的 config → `<DSH_HOME>\abd-rescue\config.json`。把 `abd-rescue.config.example.json` 复制过去改即可，重启生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `autoContinue` | true | 检测到场景时自动补发 |
| `continueMax` | 3 | 每会话（预算窗口）最多补几次 |
| `continueText` | 继续。刚才的工具调用被中断，请重试 | 补发文案 |
| `delayMs` | 1000 | 基础延迟（首发总延迟 = 它 + backoff 首档） |
| `backoffMs` | [1500, 5000, 15000] | 第 1/2/3 次补发的额外退避 |
| `skipOwnedAgents` | true | 子 agent 不插手 |
| `resumeDelayMs` | 500 | 会话重开后挂起补发的重发延迟 |
| `notifyCommand` | "" | 需要人知道的事额外执行的命令，`{msg}` 替换成正文 |
| `logMaxBytes` | 5242880 | 日志轮转阈值 |

## 开发

```powershell
node --test "test/*.test.js"   # 核心单测 + 装配层集成测试（假 ctx 走真实事件链）
node tools/replay.mjs          # 全量会话日志回归回放（断言式）
```

约束（从 dsh-unstuck 继承）：补发消息的 `source.kind` 必须是 `dsh-abd-rescue` 自己的，否则自己的补发会被当成真人输入重置预算 → 无限补发循环；发送那一刻重新校验 status / inbox / 事件流，不能只信触发时的快照。
