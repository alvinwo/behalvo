# 本地 Agent MVP（中文辅助说明）

> 英文文档 [`local-mvp.md`](local-mvp.md) 是主文档；如有差异，以英文为准。

这一版已经可以在本地启动一个持久化 Agent REPL。它把 Pi 只当作模型/provider transport；Journal、State、WorkItem、Fact、Thread 和 Context 都由 Behalvo 自己维护。

## 先跑离线版

```bash
npm ci
npm run agent -- --offline
```

常用命令：

```text
/model
/new [thread-id]
/work
/work <work-id>
/state
/history
/context
/quit
```

重启/跨 Thread 的完整验证：

```bash
npm run mvp:demo
```

## 更名兼容性

项目品牌改为 Behalvo。推荐使用 `BEHALVO_*` 环境变量；原有 `OPERATOR_*` 名称仍可用。优先级是命令行参数、新变量、旧变量、原默认值。数据库路径、workspace/owner ID、Journal 和凭证格式不变；已有数据无需迁移。

## 使用 Codex 订阅

目前 Pi 的最新版本要求 Node.js 22.19+。在自己的电脑上：

```bash
npm install --no-save @earendil-works/pi-ai
npm run agent
```

进入 REPL 后：

```text
/login openai-codex oauth
/model
/model openai-codex <Pi 列出的模型 ID>
```

OAuth credential 默认保存在 `data/pi-auth.json`，不会写入 Agent Journal、Prompt 或 State。ChatGPT/Codex subscription 不是普通 OpenAI API key；这里走的是 Pi 提供的 Codex OAuth provider。

## 目前的 Memory 边界

- 原始历史：一直保留在 Journal / artifact 中；
- 当前真相：State projection；
- 长期事务：WorkItem；
- 结构化事实：Fact；
- Thread：通信历史，不拥有全局状态；
- LLM context：每次临时构造的有限视图；
- provider session：只能当 cache hint，不能当记忆来源。

这一版还没有自动 summary / semantic retrieval。长会话超出 context 后，原文不会丢，但旧内容目前主要依赖结构化 WorkItem/Fact，而不是自动从整段历史里智能召回。这是下一阶段需要继续做的 memory 功能。

## 还没有做

Email/relay、WhatsApp/WeChat、手机号/语音、browser automation、自动 memory consolidation、model 发起的现实 side effect、24/7 daemon 和 hosted service 都不在这一版 MVP 中。
