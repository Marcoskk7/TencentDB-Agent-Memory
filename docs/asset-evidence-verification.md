> ⚠️ **此文档已过时。请以项目中确认有效的最新 spec 为准进行开发。**

# 资产证据修复后的验收指南

## 当前边界

可验收范围是 **standalone SQLite + Claude Code Proxy 固定绑定 Skill + 本地显式采集 + Panel 审核**。

集成测试使用真实 Core Gateway、SQLite、Skill 读写 API、Proxy evidence runtime、实际 Git 仓库/测试进程、Panel BFF 和不同用户身份。模型声明是测试输入，不是真实 Claude Code/上游模型聊天，也未验证完整 Proxy HTTP 转发入口，不能称为全量 spec 验收。

尚未覆盖：service/MongoDB、多节点一致性、Wiki/Code/Chat-memory 自动快照、全部真实 Claude Code compact/subagent 请求形态、自动隔离工作区对照评测。fork 当前按请求标识划分，不保证多轮子 Agent 的执行边界。candidate 审核通过不会自动发布正式资产。

## 1. 准备账号和真实资产

1. 使用已能正常聊天的 Claude Code → Proxy → Core 环境。首次验收不要连接生产数据；Core 使用 standalone，SQLite 目录应持久化。
2. Core 开启 Skill 模块（`skill.enabled: true`，或 `TDAI_SKILL_ENABLED=true`）。Panel 与 Proxy 必须指向同一个 Core 实例。
3. 准备同团队三个真实账号：资产/Agent 所有者、member、reviewer；另准备外团队账号。不要用系统管理员替代普通成员测试。
4. 所有者创建或选择一个真实 Skill，将其资产状态设为 `approved`、可见性设为 `team`，固定绑定到将用于聊天的 Agent，记下 Skill ID。
5. 选择测试 Git 仓库中的一个小改动，例如按 Skill 的输入校验规则补代码和测试。开始前运行 `git rev-parse HEAD`，记录基线 commit。

## 2. 开启 Proxy evidence

在实际 Proxy 配置中加入：

```yaml
evidence:
  enabled: true
  timeoutMs: 5000
  assetIds:
    - "替换为真实SkillID"
```

`endpoint`、`apiKey`、`serviceId` 缺省时复用 `tdai` 配置；请求的 space/instance ID 优先。Skill 读取使用 `coreSkill.endpoint`、`coreSkill.serviceToken` 和用户身份，须指向同一实际 Core 实例。可以通过 `TDAI_EVIDENCE_API_KEY` 设置 evidence 网关凭据，不要提交真实密钥。

重启本地 Proxy。开关默认关闭；没有完整会话身份、approved 固定 Skill 时，不会产生相应注入记录。`assetIds` 只缩小已有绑定范围，不赋予权限。

## 3. 在 Claude Code 中执行

1. 使用所有者的用户 key，通过已有 Proxy 会话初始化选择上述 team、agent、task。
2. 给出明确任务，例如：“按团队 Skill 的输入校验规则修改这个函数，增加测试；只有确实影响实现的资产才声明使用。”
3. 让 Claude Code 实际读取、修改文件和调用工具。Proxy 提供真实资产摘要、`access_id` 和 JSON 声明协议，不需要用户手写声明替模型补记录。
4. 在 Panel“证据与审核”中按团队/任务找到运行中的 Run；也可从 Proxy 响应头 `x-evidence-run-id` 定位。
5. 检查资产 ID、版本、digest、召回/选择/注入事件、工具意图和结果、模型 claim。没有实际退出码时不能显示验证通过。

尚未人工审核时 `used` 应为 false。模型没生成有效 claim 时，应显示证据不足，不能自动判定使用。

## 4. 采集真实本地 diff 和测试

在 Panel 展开 Run 原始记录，复制 `run_id` 和要验证的 `claim_id`。显式选择 claim，避免将一次测试归因到所有召回资产。

在本地安全设置这些环境变量，不要把真实 key 放进聊天或提交记录：

```text
EVIDENCE_CORE_URL       Core根地址，例如 http://127.0.0.1:8420
EVIDENCE_SERVICE_ID     与Proxy/Panel一致的实例ID
EVIDENCE_GATEWAY_KEY    Core网关凭据（不是模型API key）
EVIDENCE_USER_KEY       该Run所有者的用户key
```

从本仓库运行，替换参数及示例测试命令：

```sh
node scripts/evidence-workspace.mjs \
  --repo /absolute/path/to/test-repository \
  --run-id run_实际ID \
  --claim-id claim_实际ID \
  --base-ref 开始前记录的commit \
  -- npm test
```

工具实际启动命令，不通过隐式 shell。上传 diff 文件名/摘要、进程状态、明确的 claim 关联；不上传补丁正文、命令参数、stdout/stderr。上传所用的 `EVIDENCE_*` 凭据不会传给测试子进程。

退出码 0 且命令前后源码快照一致才记通过。非零退出、超时、执行期间改动源码不能记通过。快照包含 Git tracked 和未忽略的 untracked 文件，**不包含 `.gitignore` 中的配置、依赖、构建产物等运行环境状态**；这不是环境一致性证明或因果评测，重要测试输入应纳入版本控制。

默认不关闭 Run。确认最终验证时增加 `--close`，记录结果后显式关闭。CLI 返回 1 表示验证未通过，2 表示采集/上传失败。关闭后不能再补普通证据，仍可人工审核。

## 5. 切换真实身份审核

1. 在独立浏览器会话分别登录 member、reviewer，或退出后换用户 key 登录；选择同一团队。
2. member 应能看证据，不能提交使用审核；绕过界面直接调用也应被拒绝。
3. reviewer 打开相同 Run，在目标资产下选择“支持”，填写理由并勾选该 claim 直接关联、或通过 validation 明确关联的行为/diff。无关资产证据不能成为支持依据。
4. 保存后刷新回执：`used=true`；关联验证满足实际退出码要求时，`validation_passed=true`；没有可信对照时，`contributed=false`。
5. 核对审核人、理由、时间；伪造请求字段不能替换审核人。
6. 外团队账号获取相同 Run 应被拒绝。切换团队不等于切换用户身份。
7. 用另一个 Run 测试“不支持”和“测试失败”。拒绝不会被后来的支持静默覆盖；纠正须引用原审核事件并留下审计。

## 6. 关闭、历史回执和 candidate

关闭后检查 candidate 的来源 Run、diff、validation。reviewer 单独批准/拒绝 candidate；它与“资产是否用于当前任务”的审核独立，不会自动发布 Skill。

Core `/v3/evidence/task-runs/receipt` 接受 `{run_id, revision}` 查询已保存版本。Panel 默认展示当前回执。运行中的当前回执是动态视图，关闭及后续审核形成的已保存版本不能覆盖。

同一 Claude Code 会话在显式关闭后再发起任务，应新建 Run；Proxy 重启后继续尚未关闭的主任务，应恢复原 Run 和工具关联，不能拿其他用户或 fork 的记录。

## 自动回归

```sh
cd MemoryCore
npx vitest run src/evidence src/gateway/evidence-handlers.test.ts
cd ../MemoryProxy
npm test -- src/session/claude-code/__tests__
cd ../MemoryPanel
npm test -- tests/panel/evidence-live-chain.test.ts tests/panel/evidence-routes.test.ts tests/evidence-review-links.test.ts tests/evidence-comparison.test.ts
cd ..
node --test scripts/evidence-workspace.test.mjs
```

`MemoryPanel/scripts/evidence-panel-demo.ts` 仍是合成数据 UI 演示，不能替代真实聊天验收。
