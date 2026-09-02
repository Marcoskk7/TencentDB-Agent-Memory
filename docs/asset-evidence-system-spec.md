# 面向 AI Coding 的团队资产可感知复用系统

## 1. 文档目的

本文档定义首期 MVP 的实现范围，供开发 Agent 直接执行。

目标不是统计“召回了多少资产”，而是建立以下可查询证据链：

```text
资产来源 → 任务相关性 → 选择 → 注入 → Agent 声明 → 代码/工具行为 → 测试结果 → 使用回执
```

系统必须区分资产被召回、被注入、被实际采用和产生贡献这几个概念。

## 2. 范围说明

### 2.1 仓库已有能力

以下能力已经存在，本项目应复用，不要重新设计一套平行资产系统：

- 资产类型：`skill`、`llm_wiki`、`code_graph`、`chat_memory`；
- 资产版本、来源、状态、更新时间、使用次数等 metadata；
- `draft`、`candidate`、`approved`、`deprecated` 等资产状态；
- ACL 和资产读取权限检查；
- Agent 固定资产绑定；
- Skill 搜索、列表和详细读取；
- MemoryProxy 的动态 Skill listing：会话预热时可根据 Agent/Task 描述构造查询；
- 会话初始化和系统 Prompt 注入；
- MemoryProxy 的协议无关 InjectionPipeline、hook cache 和 InjectionObserver；
- `/analyse` marker 下已有 `<asset_reflection>` 提示，要求 Agent 复盘本轮资产工具是否起作用；
- 资产导入工具；
- 现有 `/v3/meta` 管理面接口和 TypeScript SDK；
- `docs/asset-evidence-chain.md` 中的 TaskRun 和证据链设计草案。

### 2.2 本项目新增能力

- TaskRun 级别的执行审计边界；
- 资产召回、选择、注入和声明事件；
- Agent 使用声明协议；
- 行为、代码 diff、测试和资产之间的关联；
- 人工审核和状态推导；
- CLI/JSON 资产使用回执；
- Claude Code 的请求、SSE、tool_use/tool_result 接入；
- 基础 with-assets / without-assets 对照评测（以 Claude Code 为首个适配器）；
- 任务结束后的 candidate 资产生成；
- 动态资产选择和两阶段上下文注入。

已有的 `<asset_reflection>` 只能作为 Agent 自述信号，不能直接推导 `used`。本项目需要在其基础上增加结构化 claim、行为关联和人工审核。

### 2.3 本期不做

- 完整历史开发 Session 自动抽取；
- 复杂的独立 LLM verifier；
- 自动把一次任务中的推断发布为 `approved` 资产；
- 大规模评测平台；
- 替换现有资产、ACL、Skill 存储模型；
- CodeBuddy 专用适配器。

任务 1 本期降级为种子资产和现有资产导入。演示环境至少准备 3 项带来源信息的资产。

## 3. 核心概念

### 3.1 Task 和 TaskRun

现有 `Task` 是业务任务或任务分组。新增 `TaskRun` 表示一次实际执行。

同一个 Task 可以有多个 TaskRun，例如：

- 使用资产的执行；
- 不使用资产的对照执行；
- 失败后的重试执行。

资产效果和证据必须绑定到 `TaskRun`，不能只绑定到 Task。

### 3.2 资产快照

资产被读取时必须锁定以下信息：

- `asset_id`；
- `asset_type`；
- `version`；
- `content_digest`；
- `source_ref`；
- 读取时的权限和状态。

任务执行期间资产更新，不影响本次 TaskRun 使用的快照。

### 3.3 证据状态

系统分为两层：

1. **事实事件**：只记录实际发生过什么，事件只追加，不直接写入 `used`、`validated` 或 `contributed` 等最终结论；
2. **派生结果**：服务端读取同一 `access_id` 关联的全部事实事件，使用确定性规则计算当前证据结果。

调用方不能直接修改派生结果。迟到或纠正事件追加后，服务端重新计算结果并生成新的回执版本，但不能修改历史事件。

事实事件包括资产访问、选择、注入、Agent 意图声明、Agent 使用声明、工具行为、代码 diff、验证、人工审核和对照评测。

每个 `access_id` 的证据结果至少包含以下独立字段：

```text
recalled: boolean
selected: boolean
injected: boolean
declared_used: boolean
used: boolean
validation_passed: boolean
contributed: boolean
```

这些字段不是互斥的状态。例如，资产可以已经 `used`，但验证失败；也可以验证通过，但没有证据证明 Agent 使用了该资产。

派生规则如下：

- `recalled`：存在该 `access_id` 的有效资产访问/召回事实；
- `selected`：存在通过权限、相关性、版本、环境和 Token 预算筛选的选择事实；
- `injected`：存在摘要、全文或可调用读取入口实际注入上下文的事实；仅被搜索或选中不算注入；
- `declared_used`：存在 Agent 对该 `access_id` 提交的 `declared_usage=used` 声明；
- `used`：存在人工审核 `decision=support`，且审核引用了该资产关联的行为、diff、决策或其他任务证据；
- `validation_passed`：存在 `passed=true` 的验证结果，且验证明确关联到该资产的 claim、行为或 diff。它表示关联行为或修改通过验证，不表示资产本身正确，也不表示资产产生了因果贡献；
- `contributed`：`used` 和 `validation_passed` 均成立，并且存在通过污染检查的 with-assets/without-assets 对照增益或其他预先定义的独立因果证据。

异常或覆盖结论单独记录，不与上述布尔字段混为一个线性状态：

```text
not_used
rejected
corrected
```

- `not_used`：资产已注入，但 Agent 明确声明未使用；
- `rejected`：人工审核明确判定资产没有支持该行为；即使关联测试通过，也不能推导 `used` 或 `contributed`；
- `corrected`：资产被证明错误、过期或不适用，必须引用纠正原因和相关证据。

没有人工 support、行为/决策/diff 映射时，不能推导 `used`。没有明确关联的通过验证时，不能推导 `validation_passed`。测试通过不能单独推导 `contributed`。

## 4. 系统流程

```text
Claude Code main 请求
  ↓
请求分类：main / fork / sidequery / compact / title-gen
  ↓
仅 main/fork 创建或恢复 TaskRun
  ↓
提取真实用户任务、仓库、分支和环境信息
  ↓
召回候选资产，记录 recalled
  ↓
权限/相关性/版本/成本筛选，记录 selected
  ↓
注入摘要或提供按需读取入口，记录 injected
  ↓
Agent 执行前输出意图声明，执行后输出使用声明
  ↓
Proxy 记录 SSE tool_use、tool_result、workspace diff 和测试
  ↓
人工审核声明是否成立，关联验证结果
  ↓
推导 validation_passed/contributed，生成资产使用回执
  ↓
关闭 TaskRun；candidate 生成异步执行
```

会话初始化表单本身不作为任务行为。拿到真实用户任务后再创建或更新 TaskRun。

## 5. 动态资产检索和上下文组织

### 5.1 检索输入

动态检索至少使用以下信息：

- 用户任务描述；
- Agent 描述；
- Task 描述；
- 仓库名称和当前分支；
- 当前 commit；
- 任务类型，例如 bug fix、feature、test、review；
- 已识别的模块或文件。

### 5.2 检索流程

```text
任务分类
  → 按资产类型路由
  → 现有 Skill/Wiki/Code Graph/Chat Memory 搜索
  → ACL 过滤
  → 版本、过期时间和环境兼容检查
  → 相关性重排
  → Token 预算筛选
  → 生成注入清单
```

首期应复用现有搜索能力和 SkillInjector 的预热机制，先实现任务信息补充、规则加分和预算过滤，不要求引入新的向量数据库。

### 5.3 两阶段注入

第一阶段只注入低成本摘要：

- 资产名称和类型；
- 一句话摘要；
- 适用范围；
- 版本和 digest；
- `access_id`；
- 完整读取方式。

第二阶段在 Agent 明确需要时读取完整资产内容。完整资产内容必须使用明确边界，并标记为团队资料，不能覆盖系统指令。

每次注入必须带稳定引用：

```xml
<team_asset_candidate
  access_id="acc_123"
  asset_id="skill_retry"
  asset_type="skill"
  version="3"
  digest="sha256:..."
  applicability="API client retry and backoff">
  该资产适用于 API 重试和退避策略。
</team_asset_candidate>
```

“根据使用声明删除未使用上下文”只能作为后续轮次优化，不能作为当前任务唯一的最小上下文策略。首期优先采用摘要注入和按需读取。

## 6. 数据模型

### 6.1 TaskRun

```ts
interface TaskRun {
  run_id: string;
  team_id: string;
  task_id?: string;
  agent_id: string;
  user_id: string;
  agent_source: string;
  session_id: string;
  request_id: string;
  execution_id: string;
  task_goal: string;
  repo?: string;
  branch?: string;
  base_commit?: string;
  head_commit?: string;
  variant?: "with_assets" | "without_assets" | "oracle";
  evaluation_group_id?: string;
  parent_run_id?: string;
  run_kind?: "main" | "fork" | "subagent" | "retry" | "control" | "oracle";
  model_fingerprint?: string;
  environment_fingerprint?: string;
  prompt_config_digest?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  close_reason?: string;
  last_heartbeat_at?: string;
  created_at: string;
  closed_at?: string;
  receipt_revision?: number;
}
```

### 6.2 AssetAccess

```ts
interface AssetAccess {
  access_id: string;
  run_id: string;
  asset_id: string;
  asset_type: "skill" | "llm_wiki" | "code_graph" | "chat_memory";
  version: number;
  content_digest: string;
  source_ref?: string;
  mode: "search" | "read" | "inject";
  reader_team_id: string;
  reader_agent_id: string;
  reader_user_id: string;
  adapter?: string;
  read_at?: string;
  selection_score?: number;
  selection_reason?: string;
  token_estimate?: number;
  compatibility_risk?: string;
  created_at: string;
}
```

### 6.3 AgentUsageClaim

```ts
interface AgentUsageClaim {
  claim_id: string;
  run_id: string;
  access_id: string;
  declared_usage: "used" | "not_used" | "uncertain";
  purpose: string;
  decision_refs?: string[];
  behavior_refs?: string[];
  diff_refs?: string[];
  validation_refs?: string[];
  files?: string[];
  reason?: string;
  created_at: string;
}
```

### 6.4 EvidenceEvent

```ts
interface EvidenceEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  type:
    | "task_run_started"
    | "asset_recalled"
    | "asset_selected"
    | "asset_injected"
    | "asset_read"
    | "intent_declared"
    | "agent_declared"
    | "behavior_observed"
    | "diff_recorded"
    | "validation_recorded"
    | "review_recorded"
    | "correction_recorded"
    | "evaluation_recorded"
    | "candidate_generated"
    | "task_run_closed";
  data: Record<string, unknown>;
  schema_version: number;
  actor?: { type: "proxy" | "agent" | "user" | "system"; id?: string };
  occurred_at: string;
  received_at: string;
  idempotency_key: string;
}
```

事件只追加，不允许修改历史事件。迟到事件按服务端写入顺序追加到末尾，同时保留客户端提供的实际发生时间和服务端接收时间。
同一 `run_id` 下的 `idempotency_key` 必须唯一；重复提交返回第一次写入的结果，不产生新事件。

`data` 不能任意扩展为无约束 JSON。每种事件必须有对应的版本化 schema，并校验必填字段、引用对象归属、最大长度和调用者权限。

### 6.5 其他记录

首期可以使用独立表，也可以把较小记录放入事件 data，但必须能查询以下对象：

- `Decision`：技术决策和理由；
- `Behavior`：工具名称、目标文件、命令摘要、结果摘要；
- `CodeDiff`：基线 commit、文件、增删行、diff digest；
- `Validation`：命令、退出码、通过状态、验证者；
- `Review`：审核人、结论、理由和关联证据；
- `CandidateAsset`：候选内容、来源 TaskRun、验证结果和审核状态。

`AssetAccess`、`Behavior`、`CodeDiff`、`Validation` 和 `Review` 的引用必须能通过服务端外键或等价校验追溯到同一 TaskRun，不能只保存无法验证的字符串 ID。

## 7. API 设计

新增 `/v3/evidence` 接口，沿用现有 Bearer、service id、user key 鉴权方式。

### 7.1 创建 TaskRun

```http
POST /v3/evidence/task-runs
```

请求体为 `TaskRun` 中除 `run_id/status/created_at/closed_at` 外的字段。

要求：

- 调用者必须有对应 team/agent/task 权限；`team_id`、`agent_id` 和 `user_id` 必须从鉴权上下文校验，不能只信任请求体；
- `run_id` 由服务端生成；
- `request_id` 由 Claude Code 请求或服务端生成；`execution_id` 由 Proxy 生成；
- 支持 `Idempotency-Key`；
- 创建时写入 `task_run_started`。

### 7.2 记录资产访问和阶段事件

资产访问必须先创建 `AssetAccess` 快照。Proxy 只有在获得 ACL 允许、并拿到资产版本和 digest 后，才能调用：

```http
POST /v3/evidence/task-runs/:run_id/accesses
```

该接口由服务端生成 `access_id`，写入资产版本、digest、source、读取者和读取时间，并同时追加 `asset_recalled` 或 `asset_read` 事实。检索只返回元数据时，也必须使用 ACL 校验后的版本和 digest；若无法取得 digest，不得进入 `injected`。后续 `selected`、`injected` 和 claim 只能引用已存在的 `access_id`。

工具行为和代码 diff 也必须有明确写入路径：

```http
POST /v3/evidence/task-runs/:run_id/behaviors
POST /v3/evidence/task-runs/:run_id/diffs
```

这两个接口分别生成 `behavior_id` 和 `diff_id`，供 claim、review 和 validation 引用。它们只保存脱敏后的摘要、digest 和必要的文件/命令元数据，不保存完整对话或未经脱敏的输出。

阶段性事件仍可通过以下接口追加，但每种事件必须使用对应的版本化 schema：

```http
POST /v3/evidence/task-runs/:run_id/events
```

请求：

```json
{
  "type": "asset_selected",
  "idempotency_key": "select-run123-acc123",
  "data": {
    "access_id": "acc_123",
    "reason": "与 API retry 任务高度相关",
    "token_estimate": 180
  }
}
```

服务端校验：

- 事件类型合法；
- `run_id` 存在且未关闭；
- `access_id` 属于当前 TaskRun；
- 资产版本和 digest 与快照一致；
- 相同幂等键重复提交不产生重复事件。

事件写入、对象创建和幂等键检查必须在同一事务或等价的原子操作中完成。

### 7.3 Agent 使用声明

```http
POST /v3/evidence/task-runs/:run_id/claims
```

请求体为 `AgentUsageClaim`。

声明只产生 `agent_declared` 事件，不直接产生 `used`。

如果需要记录执行前的预计用途，应使用单独的 `intent_declared` 事件；执行后的 `agent_declared` 才表示 Agent 对实际使用情况的声明。两者不应混用。

### 7.4 人工审核

```http
POST /v3/evidence/task-runs/:run_id/reviews
```

```json
{
  "access_id": "acc_123",
  "decision": "support",
  "reason": "代码中的退避时间和资产第 2 步一致",
  "behavior_refs": ["beh_01"],
  "diff_refs": ["diff_01"],
  "reviewer_user_id": "user_456"
}
```

`decision` 只能是：

- `support`：推导 `used`；
- `not_support`：推导 `rejected`；
- `uncertain`：保持待审核状态。

### 7.5 验证结果

```http
POST /v3/evidence/task-runs/:run_id/validations
```

```json
{
  "command": "pnpm test -- api",
  "passed": true,
  "exit_code": 0,
  "validation_type": "test",
  "claim_refs": ["claim_01"],
  "diff_refs": ["diff_01"]
}
```

只有验证结果与该资产的 claim、behavior 或 diff 存在明确关联时，才能推导 `validation_passed`。验证通过只说明关联行为或修改通过验证，不等于资产产生了贡献。

### 7.6 获取证据和回执

```http
GET /v3/evidence/task-runs/:run_id
GET /v3/evidence/task-runs/:run_id/receipt
```

返回：

- TaskRun 基本信息；
- 资产列表及当前状态；
- 事件链；
- decision/behavior/diff/validation/review 关联；
- 风险和证据缺口；
- Token、时延、工具调用统计；
- candidate 资产列表。

### 7.7 关闭 TaskRun

```http
POST /v3/evidence/task-runs/:run_id/close
```

关闭时：

- 推导每项资产最终状态；
- 生成回执快照；
- 可选提交 candidate 生成任务；candidate 内容异步生成，不阻塞关闭；
- 写入 `task_run_closed`；
- 关闭后不再接受普通事件，只允许追加 `correction_recorded`，且必须引用被纠正的原事件、原因和操作者；追加纠正后生成新的 receipt revision，不修改旧回执。

## 8. Claude Code 接入要求

### 8.1 请求分类和 TaskRun 绑定

Claude Code 请求入口为 `POST /claude-code/:spaceId/v1/messages`。Proxy 使用以下 Header 识别会话，优先级从高到低：

```text
x-claude-code-session-id
x-session-id
x-conversation-id
```

请求分类规则：

- `main`：创建或恢复主 TaskRun；
- `fork` / `subagent`：创建独立 TaskRun，通过 `parent_run_id` 关联；
- `sidequery`：只记录轻量证据，是否归入主 Run 必须显式配置；
- `compact`、`title-gen`、session-init：不创建普通任务证据。

主任务请求需要：

1. 识别 session id、request id 和真实用户任务；
2. 创建或恢复 TaskRun；
3. 执行动态资产检索；
4. 写入 recalled/selected/injected 事件；
5. 将资产摘要和 `access_id` 注入 Anthropic `system` 字段；
6. 将 `run_id` 传递到 Proxy 内部请求、SSE 和工具关联上下文。

### 8.2 Anthropic SSE 和行为采集

Proxy 必须按 `content_block_start`、`content_block_delta`、`content_block_stop` 缓冲完整响应。

- assistant 的 `tool_use` 写入行为意图；
- 后续请求中的 `tool_result` 写入执行结果；
- 没有退出码时，执行状态只能是 `unknown`；
- compact、title-gen 和 session-init 的 tool_use 不进入普通任务证据；
- 流式响应结束前不能重复提交 claim。

实际代码 diff 优先由 workspace hook 或 TaskRun 关闭时的 git 扫描提供。Proxy 无法访问 workspace 时，记录 `diff_unavailable`，不得伪造 diff。

### 8.3 Agent 使用声明格式

优先使用 Claude Code 可传递的结构化 tool。不可用时，在 assistant 最终 text block 中使用以下兼容格式：

```xml
<asset_usage>
{
  "schema_version": 1,
  "claims": [
    {
      "access_id": "acc_123",
      "declared_usage": "used",
      "purpose": "确定 API retry 退避策略",
      "files": ["src/api.ts"],
      "reason": "采用资产中的 exponential backoff 规则"
    }
  ]
}
</asset_usage>
```

Proxy 负责：

- 在完整 SSE text 拼接后解析 JSON；
- 校验 `schema_version`、字段长度和声明块数量；
- 校验 `access_id` 属于当前 TaskRun；
- 校验 `behavior_refs`、`diff_refs` 和 `validation_refs` 属于当前 TaskRun；
- 写入 claims/evidence；
- 从用户可见文本中移除该隐藏块；
- 解析失败时保留普通回复，但不生成使用声明。

不能把普通自然语言中的“我使用了某某 Skill”直接视为有效声明。

### 8.4 系统 Prompt 指令

注入说明应要求 Agent：

- 只有实际影响决策、代码、工具调用或测试时才声明 `used`；
- 没有使用时声明 `not_used`；
- 每条声明必须引用 `access_id`；
- 必须填写用途、文件或决策；
- 不要为了让回执好看而虚构使用记录。

## 9. 资产效果评测

首期实现一个最小对照实验：

```text
同一任务 + with_assets
同一任务 + without_assets
```

两个 TaskRun 使用相同的任务描述、仓库基线、Claude Code 版本、模型配置、Proxy 配置、工具集合和运行环境，只改变资产上下文。两个变体必须使用隔离 workspace/worktree。

单个 with-assets/without-assets 任务对只能报告结果差异，不能直接推导 `contributed`。要推导 `contributed`，评测必须通过以下检查：

- 两个变体使用相同的基线 commit、模型/工具配置和环境指纹；
- 两个变体使用隔离的工作区，不能共享未提交修改或运行时上下文；
- control run 未实际注入目标资产，with-assets run 的资产版本和 digest 可追溯；
- 评测结果包含任务结果、验证结果和成本指标；
- 达到预先定义的最小样本数或具备独立的因果证据，并且没有污染或冲突记录。

若上述条件不满足，回执只能标记 `contribution_evidence=insufficient`，不能标记 `contributed=true`。

记录并比较：

- 任务是否完成；
- 测试是否通过；
- 错误尝试次数；
- 工具调用次数；
- 输入和输出 Token；
- 总时延；
- 返工次数；
- 修改文件数量。

评测报告必须分开显示：

- 任务结果；
- 资产是否被采用；
- 资产是否通过验证；
- 是否存在正向增益；
- 增益是否值得额外 Token 和时延。

没有对照或独立验证时，回执只能写“已使用且已验证”，不能写“已证明产生贡献”。

## 10. 资产回流

TaskRun 关闭后，从以下内容生成候选资产：

- Agent 使用声明；
- 技术决策；
- 工具调用和命令；
- 代码 diff；
- 测试结果；
- 人工审核；
- 失败或纠正记录。

候选资产必须包含：

```json
{
  "status": "candidate",
  "source_run_id": "run_123",
  "source_diff_ids": ["diff_01"],
  "source_validation_ids": ["val_01"],
  "proposed_kind": "failure_experience",
  "content": "...",
  "confidence": 0.76,
  "review_required": true
}
```

候选资产不能自动成为 `approved`。原资产如果被证明过期或错误，只能生成纠正建议或降权建议，不能静默覆盖原版本。

## 11. 回执格式

### 11.1 CLI 摘要

```text
本次召回 8 项资产，筛选 3 项，注入 2 项。

已确认使用：
- API 重试 Skill v3：用于 src/api.ts 的退避策略
- 项目约定 v2：用于部署配置检查

已通过测试：
- API 重试 Skill v3

效果状态：
- 资产已使用并通过验证
- 尚无对照实验，暂不能声明资产产生贡献
```

### 11.2 JSON

```ts
interface AssetEvidenceReceipt {
  run_id: string;
  summary: {
    recalled: number;
    selected: number;
    injected: number;
    used: number;
    validation_passed: number;
    contributed: number;
  };
  assets: Array<{
    access_id: string;
    asset_id: string;
    asset_type: string;
    name: string;
    version: number;
    source_ref?: string;
    evidence: {
      recalled: boolean;
      selected: boolean;
      injected: boolean;
      declared_used: boolean;
      used: boolean;
      validation_passed: boolean;
      contributed: boolean;
      not_used: boolean;
      rejected: boolean;
      corrected: boolean;
    };
    applicability?: string;
    decision_refs?: string[];
    file_refs?: string[];
    validation_refs?: string[];
    risks: string[];
    evidence_gaps: string[];
  }>;
  metrics: {
    tokens?: number;
    latency_ms?: number;
    tool_calls?: number;
    error_attempts?: number;
  };
  contribution_evidence?: "insufficient" | "suggestive" | "causal";
}
```

## 12. 安全和一致性要求

- 资产读取必须经过现有 ACL；
- 只允许注入 `approved` 或明确允许使用的资产；
- 记录版本和 content digest，防止版本漂移；
- 过期、环境不兼容或冲突资产必须显示风险；
- 资产内容必须经过现有清洗和边界标记，不能覆盖系统指令；
- 事件和回执不得保存 API key、secret、完整个人对话或未经脱敏的敏感 Prompt；
- TaskRun 只允许访问所属 team/agent/task 的数据；
- 事件写入必须支持幂等；
- 任何自动 verifier 只能追加建议，不能覆盖人工审核结论。

## 13. 建议代码拆分

实现时优先新增以下模块，避免修改无关的上下文压缩逻辑：

```text
MemoryCore/src/evidence/
  types.ts
  evidence-store.ts
  evidence-service.ts
  state-derivation.ts
  receipt-builder.ts
  candidate-generator.ts

MemoryCore/src/gateway/
  evidence-handlers.ts
  evidence-schemas.ts
  evidence-router.ts

sdk/memory-core/typescript/src/v3/
  evidence-types.ts
  evidence-client.ts

MemoryProxy/src/session/claude-code/
  evidence-context.ts
  usage-claim-parser.ts
  tool-evidence.ts
```

CodeBuddy 不属于本期适配范围。若其他 Proxy 不在当前仓库，至少实现：

- Evidence SDK；
- 注入清单的数据结构；
- Agent 声明协议；
- 一个可运行的 demo adapter；
- 端到端测试用的 HTTP 调用样例。

## 14. 验收标准

### 基础链路

- 创建 TaskRun 后能记录资产 recalled/selected/injected；
- Claude Code main/fork 请求能正确创建独立 TaskRun，compact/title-gen/session-init 不创建普通任务证据；
- 每次注入都有 `access_id`、版本和 digest；
- Agent 声明能关联具体资产、文件和决策；
- Anthropic SSE 的 tool_use 与后续 tool_result 能关联到同一行为；
- diff 和测试结果能关联到 claim；
- 能通过 API 获取完整事件链和回执。

### 状态正确性

- 仅召回不能显示为 used；
- 仅注入不能显示为 used；
- 仅 Agent 声明不能显示为 used；
- 人工 support 后才能显示 used；
- 无关联的通过验证时不能显示 validation_passed；
- 无对照或独立因果证据时不能显示 contributed；
- not_support 和 corrected 能被正确展示。

### 上下文控制

- 动态检索结果受 ACL、版本和 Token 预算限制；
- 默认注入摘要而不是所有资产全文；
- 未选资产不会进入完整 Prompt；
- 同一任务可以执行 with_assets 和 without_assets 两种变体。

### 回流和安全

- 任务关闭后可以生成 candidate 资产；
- candidate 不会自动变成 approved；
- 事件写入幂等；
- 原始 secret 和敏感对话不会进入证据记录；
- 现有资产、ACL、Skill 接口测试不回归。

## 15. 交给开发 Agent 的执行 Prompt

你需要在当前仓库实现 `docs/asset-evidence-system-spec.md` 中定义的 MVP。

先阅读仓库现有的 asset、ACL、Skill listing、metadata router、TypeScript SDK 和 `docs/asset-evidence-chain.md`。复用现有数据模型和鉴权，不要重新实现资产存储或权限系统。

实现顺序：

1. 新增 evidence 类型、存储和状态推导逻辑；
2. 新增 `/v3/evidence` API 及 TypeScript SDK；
3. 实现 TaskRun、AssetAccess、AgentUsageClaim、Review、Validation 和 Receipt；
4. 在 MemoryProxy 接入 Claude Code main/fork/auxiliary 请求分类；
5. 实现 Anthropic SSE、tool_use/tool_result 和 Agent 声明解析；
6. 接入动态资产选择、两阶段上下文注入、workspace diff 和测试关联；
7. 实现 with-assets / without-assets 的基础评测记录；
8. 实现 candidate 资产生成；
9. 添加单元测试、API 测试和一个 Claude Code 端到端 demo。

必须遵守：

- `used` 必须经过人工 support；
- `validation_passed` 必须有关联的通过验证；
- `contributed` 必须有反事实或独立因果证据；
- 事件不可变且支持幂等；
- candidate 不能自动 approved；
- 不修改无关功能；
- 完成后运行现有测试和新增测试，并报告未实现的适配器边界。

最终交付：

- 实现代码；
- 数据库迁移；
- TypeScript SDK；
- 测试；
- demo；
- 简短的实现说明和已知限制。
