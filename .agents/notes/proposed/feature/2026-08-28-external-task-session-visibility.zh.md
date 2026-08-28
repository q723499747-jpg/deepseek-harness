# Agent Note：外部任务 Session 的持久恢复与可见性

Status: proposed

[English](2026-08-28-external-task-session-visibility.md) | 中文

## Problem

一个集成可以在不启动模型回合的情况下拥有持久 Session。它的 log-only 任务事件和卡片可在重启后保留，但 Session 列表投影只识别 `turn/start`，所以仍返回 `blank: true`。Web 列表会隐藏该 Session，导致持久任务历史可由 API 寻址，却无法在工作区发现。

Host 重启后，同一持久 Session 还可能不在内存 registry。复用任务时不能挂载 Agent、虚构回合，也不能让每个集成自行扫描持久化文件。普通 persistence preparation 可能提交崩溃修复；对于必须证明 archive 未改变的 replay 路径，这个能力范围过宽。

追加 `turn/start` 或 `user/message` 会把外部进程误写成模型交互。保留集成私有的列表覆盖会使 Session 可见性依赖各个客户端，也无法在 Host 重启后恢复。

## Proposal

`SessionController.markExternalTaskVisible(session, marker)` 幂等追加一条 `session/external-task` 事件。标记只携带 producer 名称和不透明 task id。它是 log-only：模型历史、token 统计和回合生命周期都会忽略它。

`SessionPersistence.prepareExact(sessionId)` 只预留当前且已平衡的源，任何需要持久修复的源都会被拒绝。`SessionController.resolveDurableSession({ sessionId, workspacePath })` 校验精确 workspace，并通过共享的并发 hydrate 把该 prepared Session 发布到 live registry。它不挂载 Agent，也不追加事件。`resolveDurableSessionSafe()` 把 persistence、身份、workspace 和 registry 发布失败映射为供 Host 消费的稳定无内容错误码。hydrate 与列表可见性刻意分离：恢复绝不调用 `markExternalTaskVisible`。

`sessionListMetadata` 投影把 `turn/start` 或 `session/external-task` 视为 Session 非空的证据。投影 state version 同步递增，旧 projection cache 行无法在升级后保留过期 blank 状态。普通 persistence log 和投影重放使该决定在重启后保留，无需可变 Session header 或客户端私有例外。

## Alternatives considered

**追加合成模型回合。** 拒绝，因为它会制造虚假模型历史，并破坏从未调用模型的操作所不应触碰的回合不变量。

**由各集成修改 Web 列表。** 拒绝，因为它既不持久也不权威，而且每个集成都必须复制客户端行为。

**扩展不可变 Session header。** 拒绝，因为外部任务在 Session 已存在后才形成，而 header 是创建时元数据；零事件 Session 也被刻意排除在 persistence listing 外。

**让集成扫描或解码持久化制品。** 拒绝，因为存储格式、修复策略和 registry 发布属于 Session persistence 与 Session Controller，不属于 Todo 或其他 producer 插件。

**使用普通 Agent resume。** 拒绝，因为它会挂载面向模型的运行状态，并可能执行与恢复稳定外部任务身份无关的工作。

## Acceptance criteria

- 只有一条 external-task 标记的 Session 以 `blank: false` 出现在列表，且日志不含 `turn/start`、`user/message` 或 assistant 事件。
- 重复相同 producer/task 标记保持幂等。
- 持久投影重放在重启后保持 Session 可见。
- 普通 blank Session 与模型回合 Session 的行为不变。
- 已平衡的冷 Session 可在精确 workspace 中 hydrate 到 registry，且不改变持久制品、不挂载 Agent。
- 缺失、损坏、错误 workspace、身份不一致和需要修复的源都会以稳定错误码失败关闭；并发 hydrate 只发布一个精确 Session。
- 单独 hydrate 不改变列表可见性和事件日志。

## Risks

集成若在取得持久所有权前标记任务，可能暴露空行。因此 Host 集成只能在自身持久 reservation 成功后调用该方法。标记不携带显示文本、actor 身份、凭据、URL 或业务 payload，所以列表可见性不会形成第二份数据投影。

精确 hydrate 会拒绝可恢复的中断尾部而不是修复它。需要普通崩溃恢复的调用方必须显式使用既有 resume 流程；更严格的外部 replay 路径以可用性换取可验证的零写保证。
