# Evidence 前置核验与复用记录

核验日期：2026-09-03。唯一工作树：`/Users/marcoskk7/github/TencentDB-Agent-Memory-evidence`。

**实际操作请从 [Evidence 真人操作测试](./evidence-manual-test.md) 开始**：包含 Skill 规则、普通对话示例、动态选择框、TaskRun 查看、reviewer 审核和真实本地测试采集。本文是前置资源快照，不是一次端到端验收成功记录。

2026-09-03 补充复核：Proxy Evidence 仍未开启；用户已尝试真实 Claude 对话，出现过选择后 thinking 400，尚未完成完整验收。以下“本轮”指最初的前置资源准备，不表示此后没有发生聊天。

结论：要求的四项前置资源已补齐，但额外的跨团队 Skill 读取隔离检查失败，不能宣称权限验收通过。
本轮没有真实模型聊天，没有创建 TaskRun/claim/review，没有实现用户名校验任务。

## 1. 服务与实际配置

| 项目 | 核验前 | 本轮后 |
| --- | --- | --- |
| Core Skill | HTTP 404，Skill module not enabled | standalone 配置 `skill.enabled: true`，真实 create/get/listing 成功 |
| Panel | Core `http://127.0.0.1:8420`，实例 `default` | 保持不变；Panel API `http://127.0.0.1:8123` |
| Proxy Skill | Core 同上，默认实例 `context-proxy` | 改为 `default`，与 Panel/tdai 一致 |
| Proxy auth | 关闭，配置 URL 为示例地址 | 开启，URL 改为同一 Core；4 个正常账号解析成功，无效 key HTTP 401 |
| Proxy sessionInit | 关闭 | 开启，使用真实身份及 team/agent 选择，不设置 debugForceIdentity |
| Proxy Skill 工具地址 | `https://gateway.example.com` | `http://127.0.0.1:8096` |
| Proxy Evidence | 默认关闭 | 未修改；属于后续验收步骤 |

Core、Proxy 已短暂重启并通过 `/health`；Panel 保持原进程。
数据继续存于 `/Users/marcoskk7/.memory-tencentdb/memory-tdai`，没有替换数据库、使用 mock 或修改 SQL 记录。
管理员现有本地凭据仅用于通过正式用户 API 建号，后续资产操作均使用 owner 的普通账号 key。

## 2. 真实账号

原实例只有一个 `system_admin`。本轮新增以下 4 个持久、独立 key 的账号，均经 Core 和 Panel 的 `auth/verify` 确认为 `user_type=normal`。

| 用途 | 用户名 | User ID | 团队角色 |
| --- | --- | --- | --- |
| 资产及 Agent 所有者 | evidence-owner | usr-16oijv5c60 | 主团队 admin（不是 system_admin） |
| 普通成员 | evidence-member | usr-16oimsltu5 | 主团队 member |
| 审核者 | evidence-reviewer | usr-16oizbxo6h | 主团队 reviewer |
| 外团队账号 | evidence-outsider | usr-16oiejyuv9 | 外团队 owner/admin，不在主团队 |

- 主团队：`Evidence Acceptance` / `team-16oig7rq7c`。
- 外团队：`Evidence External` / `team-16oih9c8e2`。
- 私有登录凭据：`workspace/evidence-preflight/state.json` 的 `accounts.<role>.user_key`。
- 该目录已由现有 `workspace/` 规则忽略；目录权限 `0700`，凭据文件 `0600`。不要提交、分享或复制到聊天。
- 登录 Panel 时实例选 `default`。切换角色需要退出后换 key，不能仅切换团队。

## 3. 固定 Skill 与 Agent

| 字段 | 固定值 |
| --- | --- |
| Skill 名称 | evidence-username-validation-v1 |
| Skill ID / Asset ID | skl-pgTbAYpbquYG |
| Skill 版本 | 1 |
| 正文 SHA-256 | 9abde84eb02f3fcab87a3ff6013d76e0191832bb2f133ef0298ecc8806331f35 |
| Asset 状态 / 可见性 | approved / team |
| Skill 内容状态 | active（与 Asset 生命周期状态是不同字段） |
| Agent 名称 | Evidence Input Validation |
| Agent ID | agt-16oiz6rr29 |
| 所有者 | usr-16oijv5c60 |
| 固定绑定 | injection_mode=direct，priority=100 |

正文备份：[evidence-input-validation.SKILL.md](./evidence-input-validation.SKILL.md)。
Skill 是 Core 中有正文和版本的真实应用资产，不是单独伪造的 metadata，也不是本地 Codex Skill 安装。
Panel 对 `agent-fixed-asset/*` 返回 `501 NOT_IN_SCOPE`，所以绑定通过同一 Core 的正式 API、使用 owner key 完成。
owner/member/reviewer 均验证了 Core 固定绑定，以及 Panel/Core 精确 ID、版本、正文 digest 读取。Proxy 的真实 MetadataClient 和 CoreSkillClient 也能获取此绑定与 listing。

### 维护者诊断用：精确读取（不是自然对话验收入口）

以下脚本只核对资产存储和正文完整性，不证明 Claude 自动发现、读取或使用了 Skill。进行真人操作验收时，不需要先执行它，也不要把其输出或本文交给 Claude 作为任务上下文。

在 evidence 工作树执行（若 node 已在 PATH，可直接使用 `node`）：

```sh
/Users/marcoskk7/.nvm/versions/node/v22.23.2/bin/node workspace/evidence-preflight/read-skill.mjs owner
```

可将最后参数换成 `member` 或 `reviewer`。脚本使用真实 key 调 Panel，固定 ID 与 version，校验 SHA-256 后才输出正文；不做搜索，不回退最新版，不输出密钥。

真人验收使用 [操作步骤第 3 节](./evidence-manual-test.md#3-从正确工作树发起自然对话) 的普通开发需求，不在用户提示词中指定 Skill ID、复制规则或要求补写声明。固定 ID/版本/digest 用于核对实际产生的证据，不用于替模型制造“使用”事实。

正常聊天入口为 `http://127.0.0.1:8096/claude-code/default`，用户 key 用 owner；会话初始化选择上述主团队、Agent。不同角色使用不同会话，不复用同一 conversation ID。
固定绑定不等于模型必然执行；实际读取、声明、测试及审核仍须在后续真实 Run 验证。

## 4. 小改动与基线

- 基线由实际 `git rev-parse HEAD` 得到：`39d52a3891278cdf27c6c9a4ad8eb0760c8aa339`。
- 目标：`MemoryCore/src/metadata/router/v3-meta-schemas.ts` 内 `userCreateSchema` 和 `userCreateWithKeySchema` 的 username 规则。
- 要实现：仅字符串，先 trim 再非空校验；保留内部空格、中文和大小写；不改 user_key，不影响其他实体。
- 计划新增测试：`MemoryCore/src/metadata/router/user-create-validation.test.ts`。
- 实际基线探测：两个 schema 都接受 `" \t\n"`，且 `" Alice "` 未 trim；因此这是一个真实尚未实现的小改动。
- 目标文件本轮未修改；SHA-256 已存入私有 state 并复核。测试也尚未创建/执行，不存在伪造的通过结果。
- 开始时工作树已有大量未提交实现改动。`state.json` 保存初始 `git status`；HEAD 不是这些改动的快照。后续采集 diff 必须区分原有改动，不能把整个工作树差异归因于此 Skill，更不能据此声称完成干净的 with/without 对照。

## 5. 已发现的失败项与未测范围

### 跨团队 Skill 读取：失败

使用已认证的 outsider key、其真实 user_id，但请求体填写主团队的 team_id、agent_id 和上述 Skill ID：

- Panel `/api/v1/skill/get`：HTTP 200 / code 0，返回完整正文。
- Core `/v3/skill/get`：HTTP 200 / code 0，返回完整正文。

主团队成员列表已确认没有 outsider。这是实际权限边界失败，不是只有 HTTP 200、业务码拒绝的情形。
本轮未修改权限代码。仅限本地测试数据；修复并复验前不要引入敏感或生产 Skill。
`handleGet` 使用请求中的 scope 调 `SkillCore.get`；`assertTeamMatch` 比较的是行与请求 team_id，不能单凭这个比较证明调用者属于团队。
这项观察不等于已经测过外团队 Evidence Run 接口；后者仍需独立验收。

### 可重复核验

```sh
/Users/marcoskk7/.nvm/versions/node/v22.23.2/bin/node workspace/evidence-preflight/prepare.mjs --verify
```

此模式不会新增账号或更改资产。写入本地核验报告；存在上述权限失败时退出码为 **1**，不能当作成功。
它同时检查 HEAD 与目标文件未变，因此后续真正实现用户名规则后，目标文件基线检查失败是预期行为，不应重置基线来掩盖变更。

- `workspace/evidence-preflight/verification.json`：真实账号/角色、资产/绑定、版本/正文及两项跨团队失败。
- `workspace/evidence-preflight/proxy-verification.json`：Proxy 客户端核验、真实 HTTP 无效 key 拒绝、schema 基线探测。

前置准备结束时，尚未开启 `evidence.enabled`，也未做真实 Claude Code/上游聊天、工具修改、claim、人工审核、validation 或 candidate 验收。后续的用户聊天尝试不改变“尚未完成端到端验收”的结论。当前应按 [真人操作测试](./evidence-manual-test.md) 第 0 节先确认阻塞项；通用工程检查另见 [asset-evidence-verification.md](./asset-evidence-verification.md)。`evidence.assetIds` 可以省略，以测试正常的 approved 固定绑定路径；它只是候选过滤器，不是手动注入或使用证明。
