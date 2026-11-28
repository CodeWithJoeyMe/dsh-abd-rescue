# dsh-abd-rescue

[中文](./README.md) · [English](./README.en.md)

A rescue plugin for DeepSeek Harness (DSH): **a turn ends abnormally (you didn't press stop), and that turn contained a tool call killed by "tool call aborted before dispatch" (ABORTED_BEFORE_DISPATCH, ABD) → automatically send one targeted "continue"**, so the model re-issues the aborted call.

## Why it exists

`dsh-unstuck`'s "asked-but-didn't-wait" guard actively cancels turns it believes "asked a question but kept working without waiting for the answer". A tool call aborted that way mints an `Error: tool call aborted before dispatch` in the scheduler, and you see the UI full of red ABD error cards. dsh-unstuck, by design, **does not continue its own pauses** (`isQuestionPauseAbort` exclusion + `suppressAutoContinue` suppression) — so every time the guard false-positives (it does: a "nod" inside quoted text, a self-narrated "let me confirm", or restating your "go ahead" all hit its trigger words), you have to type "continue" by hand.

**Full local audit (2026-11-22, 354 session files, reproducible with `node tools/replay.mjs`)**: of the 70 turns containing ABD tool results in existing logs, 59 were self-killed by the guard, 7 had the tool blocked but the turn eventually completed normally, 2 were upstream errors accompanied by ABD, and 2 were closed / old-format sessions (no turn/end, unrescuable live). In 49 of those turns you typed "continue" manually afterwards. This plugin catches all 61 "abnormal end + ABD" turns and correctly leaves the other 9 (already completed / closed sessions) alone.

## Behavior

| Situation | Action |
|---|---|
| Turn ends with `aborted` / `error` / `max-tokens` / `interrupted` for a non-user reason, and the turn has ABD tool results | Sends "Continue. The previous tool call was interrupted, please retry." |
| You pressed stop (`aborted{kind:'user'}`) | Left alone |
| Tool blocked but the turn eventually completed normally | Left alone (the call was cancelled and the model already found another way; a continue would only encourage a pointless retry) |
| Context overflow codes (CONTEXT_OVERFLOW etc.) | Left alone (dsh-unstuck does an overflow handoff into a new session; no message is inserted into the original one) |
| Session closed inside the send window (agent disposed) | Held-and-resend: waits for the same session to reopen (new agent registered), then re-validates and sends after `resumeDelayMs`; if you already typed something after reopening, it yields (the 2026-11-23 c5ee0860 missed-resend fix) |
| Per-session continues reach `continueMax` (default 3) | Stops + writes a log notice |
| A real human types, or the desktop "Continue" button / dsh-unstuck takes over | Budget resets |

## Deduplication while coexisting with dsh-unstuck

Both sides may want to continue a "real upstream ABD"; two rules guarantee only one continue per turn:

1. **Timing offset**: this plugin's first send is `delayMs + backoffMs[0]` = 2500ms, 300ms later than dsh-unstuck's toolAbort first send at 2200ms → lets it speak first.
2. **Re-check before sending**: if a real human message appeared after turn/end, or a `continue` / `dsh-unstuck` / continue-like message this plugin itself already sent exists → it yields. Only whitelisted kinds count (`user` = real human; harness-injected kinds like `time-context` / `skill-catalog` don't count).

## Installation

```powershell
git clone https://github.com/CodeWithJoeyMe/dsh-abd-rescue.git
cd .\dsh-abd-rescue
pwsh -File .\install.ps1          # installs into the desktop profile by default
```

`install.ps1` copies the plugin (per the files list in `package.json`) into `<DSH_HOME>\plugins\` and registers it in the profile; what actually runs afterwards is that copy — the clone directory can be deleted after installing. To upgrade, just clone fresh and run it again (requires pwsh 7+, git on PATH).

Takes effect after fully quitting and restarting DeepSeek Harness. Verify:

```powershell
Get-Content "$env:USERPROFILE\.dsh\abd-rescue\abd-rescue.jsonl" -Tail 20
# {"event":"boot"} means it's installed; every resend logs one rescue-sent
```

Uninstall: `pwsh -File .\uninstall.ps1`, then restart.

## Configuration

Three layers, later wins: built-in defaults → config in `cordis.patch.yml` → `<DSH_HOME>\abd-rescue\config.json`. Copy `abd-rescue.config.example.json` there and edit; restart to apply.

| Key | Default | Description |
|---|---|---|
| `enabled` | true | Master switch |
| `autoContinue` | true | Auto-send when the situation is detected |
| `continueMax` | 3 | Max continues per session (budget window) |
| `continueText` | 继续。刚才的工具调用被中断，请重试 | Text of the resent message |
| `delayMs` | 1000 | Base delay (first-send total delay = this + first backoff step) |
| `backoffMs` | [1500, 5000, 15000] | Extra backoff for the 1st/2nd/3rd continue |
| `skipOwnedAgents` | true | Don't touch sub-agents |
| `resumeDelayMs` | 500 | Resend delay for a held continue after the session reopens |
| `notifyCommand` | "" | Extra command to run for anything a human should know; `{msg}` is replaced with the body |
| `logMaxBytes` | 5242880 | Log rotation threshold |

## Development

```powershell
node --test "test/*.test.js"   # core unit tests + assembly-layer integration tests (fake ctx drives the real event chain)
node tools/replay.mjs          # full session-log regression replay (assertion-based)
```

Constraint (inherited from dsh-unstuck): the resent message's `source.kind` must be `dsh-abd-rescue`'s own, otherwise its own resend would be treated as real human input and reset the budget → infinite continue loop; at the moment of sending it re-validates status / inbox / event stream — the snapshot at trigger time is not trusted alone.
