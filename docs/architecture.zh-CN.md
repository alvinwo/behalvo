# Behalvo：架构 v0 中文导读

> **说明：英文是主文档语言。** 本页是辅助导读；若中文表述与英文文档存在差异，以 [`architecture.md`](architecture.md) 和正式英文 Architecture Spec 为准。

这是已经落地为代码和测试的 M0 内核预览，不是已接入个人账号、可以全天运行的成品。
项目正式采用 **Behalvo**（`behalvo`）作为品牌名。英文架构总览位于 [`architecture.md`](architecture.md)，正式规格位于 [`superpowers/specs/2026-09-07-architecture-v0.md`](superpowers/specs/2026-09-07-architecture-v0.md)。

## 1. 这版真正确定了什么

**一个单体进程、一套 Journal、一套可重建 State，以及几个窄接口。**

第一版没有拆出十几个包，没有 Event Bus，也没有多个 Agent 相互协作。
`kernel` 负责确定性的领域规则；`storage` 负责 SQLite 事务；`runtime` 负责经过验证的操作；
`memory` 负责把相关状态和历史装进一次推理的 context。

Personal 与 Business 共用实现，但**不自动共用数据可见性**。
同一个人可以拥有 `personal` 和 `business` 两个 workspace。工作区是数据分区，不是聊天 session。
未来业务客户与 agent 对话时，不能仅因客户接触的是同一个 agent，就获得主人的私人记忆。
目前代码只生成主人可见的 context；外部客户 context 直接拒绝，等待实现明确的披露规则。

## 2. Journal、State、Action 的关系

每条 JournalRecord 有独立 ID、工作区内序号、schema version、记录时间、actor、
可选的 causation reference 和类型化事件。顺序由序号决定，不用网络消息时间排序。

一次 append 在同一个事务里完成：检查版本 → 验证事件 → 写日志 → 更新 projection。
任何一步失败，都不能留下“日志说做了，但状态没变”这样的半完成结果。
两个运行实例基于旧状态同时写入时，旧的 expectedVersion 会被拒绝。
这并不意味着已经实现多进程调度；M0 仍以单进程为运行约束。

日志表的 SQL UPDATE 和 DELETE 被触发器拒绝。业务纠正应该追加新记录。
管理员控制整个数据库文件时仍可破坏这些保护，因此这里不宣称防篡改存证。

当前状态由日志 replay 得到，也可以使用 `stateAt(workspace, revision)` 查询某个旧版本。
**Replay 只运行 reducer，不再调用模型、发信、预约或执行外部操作。**

## 3. 会话结束，事务不会结束

- Thread 是一条通信流，例如 IM 聊天、邮件往来或 Web 对话。
- Run 是一次临时推理，M0 只有未来 Planner 的接口，没有真实模型执行。
- WorkItem 是跨通信方式持续存在的事务，拥有目标、状态和关联线程。

“追踪一笔退款”是一个 WorkItem。今天在 IM 讨论，明天从 Web 查询，后天收到邮件，
都通过关联关系读取同一个 WorkItem，而不是把某一个聊天窗口的摘要当成事实。
关联 Thread 也不表示其中所有消息都相关，更不表示其中所有内容都可以对外披露。

## 4. Action 不等于外部结果，更不等于用户目标

已实现的生命周期：

```text
proposed → approved → running → accepted / failed / unknown
     ↘ cancelled           unknown → 明确核实后的 accepted / failed
```

审批绑定具体 command 内容的 digest、工作区、主人、WorkItem revision 和失效时间。
执行前再检查一次，不是批准后永久有效。收件人、正文或工作上下文改变后，旧批准不能复用。

`accepted` 只是 provider 接受了操作，不自动把 WorkItem 标记为完成。
M0 支持主人带证据确认完成，并不把这个决定伪装成机器独立验证的外部事实。

如果发送后收不到响应，结果是 `unknown`。重启发现一项操作停在 `running`，也按未知处理。
系统不会为了“可靠”直接重发；先核实外部状态，再决定是否创建新的操作和审批。
自己的幂等键不能让一个不支持幂等的外部服务获得 exactly-once 保证。

## 5. 主动与被动共用同一条路径

收到消息先持久化，再 ACK。重复的 `(workspace, source binding, external_id)` 不再入队。
相同 key 带着不同正文重投递会报冲突，不能覆盖原始消息。

定时跟进也存在数据库中。到期时，timer.fired 和它的 inbox 条目在同一事务内提交。
重启后可以继续读取，重复扫描不会再次触发同一个 timer。
如果 WorkItem 已关闭或发生变化，旧 timer 会被取消，不再执行过时的跟进计划。

M0 演示的是持久化定时事件，不是一个已经运行着的后台服务。
全天运行还需要 daemon、supervisor、限流、quiet hours、预算控制和外部渠道接入。

## 6. 长历史如何进入有限 context

原始正文保存在 artifact，日志引用它。Summary 保存来源消息 ID，属于可重建的索引。
删除 context 中的旧消息，不会删除 artifact，也不会改写历史。

ContextBuilder 加载主人权限和工作区后，按顺序装入：

1. 固定约束、相关当前 WorkItem、操作状态和有效事实。
2. 当前消息及最近的原始消息，保持消息块完整。
3. 有来源链接的旧摘要，空间不够就不装入。

关键约束和当前输入都放不下时，明确报 context budget 错误，不能悄悄剪掉。
输出同时带已加载的原文 ID、摘要 ID、遗漏数量和使用的 state version。
模型需要更早的证据时，可以按 ID 读回，而不是把摘要当成不可质疑的记忆。

**本版没有自动 LLM 摘要、embedding 或多层摘要树。** 已完成的是来源关联、原文保留和
有限预算加载机制。默认用 UTF-8 字节数做保守估计，不是模型的精确 tokenizer。
接真实模型时需要专用 token counter，并预留工具定义、协议包装和输出空间。

事实包含有效期、来源和 supersedes。未来才生效的地址不会提前成为当前地址；
两个互相矛盾但都有效的记忆会返回 conflict，而不是静默挑一个。

## 7. 扩展接口与没有实现的部分

`ChannelAdapter` 负责已验证的消息入口，区分自有邮箱/号码与 relay 来源。
`Planner` 只产生 proposals；不能拿数据库连接，也不能直接调用外部执行器。
`EffectDriver` 只能执行一个已审批的具体 command，回传结果与证据。

这些是普通 TypeScript 接口，不是安全沙箱；不可信代码不能直接作为本地插件运行。
目前没有 Gmail、WeChat、WhatsApp、SMS、voice 或真实模型适配器。
IM 控制 agent 是目标；M0 的 mock IM 不代表这些平台已经接通。

## 8. 下一步最小可用范围

下一阶段只做一条真实个人工作流：**主人转发一封需要跟进的邮件，agent 维护事务，
提出跟进草稿，经主人在 IM 中确认后发送，并继续追踪回复。**

先完成认证、敏感数据保护和 provider 结果核实，再开始真实账号 dogfood。
先验证净节省的时间和误操作边界，再增加更多渠道或 Business 场景。

## 9. 运行

```bash
npm ci
npm run check
npm run demo
```

演示只使用临时数据库、合成消息和 fake provider，没有真实发信、外部 API 费用或长期后台进程。
GitHub 远端与 Projects 看板还需要实际连接授权；本地准备好的文件不等于已经发布。
