> ⚠️ **此文档已过时。请以项目中确认有效的最新 spec 为准进行开发。**

# Evidence 真人操作测试：自然对话 → TaskRun → 人工审核

核对日期：2026-09-03。唯一工作树：`/Users/marcoskk7/github/TencentDB-Agent-Memory-evidence`。

本文给实际操作者使用；账号和资产清单见 [前置核验记录](./evidence-preflight-2026-09-03.md)。目标是验证 **Claude 收到普通开发需求后，是否通过产品已有的资产绑定机制读取并使用 Skill，产生可供真人审核的证据**。

不运行 demo/造数脚本，不手工创建 Run/access/claim，不在用户提示词里塞 Skill 正文、Skill ID 或声明 JSON，也不让 Claude 代替 reviewer 审核。下列步骤是待执行的验收流程，不是已经跑通的结果。

## 0. 先看当前是否能开始

本次只读复核得到：

| 检查 | 当前情况 | 对测试的影响 |
| --- | --- | --- |
| Core / Proxy / Panel | 8420、8096、8123 的 health 均返回 200；5173 首页返回 200 | 服务入口可达，不等于模型和证据链已通过 |
| Skill 模块、真实账号、固定绑定 | 前置资源已经准备 | 不需要重新导入 Skill 或重新建号 |
| Proxy Evidence | 实际 `MemoryProxy/config.yaml` 没有开启，解析结果为 `false` | **任何提示词都不能在此配置下触发自动 TaskRun** |
| Claude 上游对话 | 选择完任务后出现过 `content[].thinking` 400；后续日志也有 200 | 尚未完成全流程稳定回归；再次出现 400 时停止该次验收 |
| 外团队 Skill 读取隔离 | 前置检查失败，尚未修复 | 仅限非敏感本地测试；不能宣称权限验收通过 |

环境维护者需先在**实际使用的 Proxy 配置**中合并以下顶层配置，并重启加载此配置的 Proxy：

```yaml
evidence:
  enabled: true
  timeoutMs: 5000
```

本例不需要填写 `assetIds`：空名单表示从当前 Agent 已有的 approved 固定绑定中选择，不是从全库任意插入资产。Core 地址、网关凭据和实例沿用已配置的 `tdai`；保持 `auth`、`sessionInit` 开启，不设置强制身份。这里给出的是待执行配置步骤，**本次文档补充没有修改配置或重启服务**。

先完成该准备，再走下面的真实对话。如果又出现 thinking 400，保留当次时间和会话记录，处理兼容性问题后用新会话重测；不要通过关闭团队选择或补写证据绕过。两轮本地选择框成功不代表上游调用成功。

## 1. 当前 Skill 到底是什么

- 名称：`evidence-username-validation-v1`；Skill ID：`skl-pgTbAYpbquYG`；验收版本：`1`。
- 归属团队：`Evidence Acceptance`；固定绑定 Agent：`Evidence Input Validation` / `agt-16oiz6rr29`。
- 资产状态 `approved`、可见性 `team`；正文内容状态 `active`。
- 完整正文备份：[用户名输入校验 Skill](./evidence-input-validation.SKILL.md)。它是 Core 内的应用资产，不是本地 Claude/Codex 安装的 Skill。

它规定两个用户创建接口的用户名处理：普通创建 `/v3/meta/user/create` 和带 Key 创建 `/v3/meta/user/create-with-key` 必须一致。

| 用户名输入 | Skill 要求 |
| --- | --- |
| 缺失、null、数字、布尔、数组、对象 | 拒绝，不能强制转换为字符串 |
| 空串、纯空格、制表符、换行、全角空格 | 拒绝 |
| `" Alice "` | 保存为 `"Alice"` |
| `" 张 三 "` | 保存为 `"张 三"`，保留内部空格 |
| `"MiXeD"` | 保持大小写 |

只调整两个 schema 的 `username` 字段，不动通用 `nonEmpty`、其他接口或 `user_key`。先补两个 schema 的回归测试，看到真实失败，再做最小实现并运行测试。

因此，本次要测的是**修复用户名校验的实际编码任务**。只说“你好”或要求“讲解”可能产生聊天/运行记录，但没有理由因此出现代码改动、测试通过或 Skill 使用成立。

## 2. 用 owner 在 Panel 确认资产、准备任务

1. 打开 [Panel](http://127.0.0.1:5173/)，实例选择 `default`，用 **evidence-owner** 的 User Key 登录。
2. 在右上角选团队 **Evidence Acceptance**。
3. 打开 **Skill 技能 → Agent 资产**，Agent 选择 **Evidence Input Validation**，点 `evidence-username-validation-v1`，在右侧 **内容 / Body** 看正文。核对上节规则；不要编辑、Fork 或重新导入。
4. 打开 **任务看板 → 新建 Task**，填写：
   - 标题：`用户名输入校验验收`。
   - 描述：`修复普通创建和带 Key 创建接受纯空白用户名的问题，补回归测试，保留已有工作区改动。`
   - 确认所属 Team 是 `Evidence Acceptance`，点击 **创建 Task**。
5. 记下新任务的 Task ID。创建弹窗不需要选择 Agent；稍后的 Claude 会话选择负责关联上下文。

已有任务 **讲解** / `task-194cek3sse` 也可以复用，但独立新任务更容易区分本次验收记录。**创建 Task 是建任务卡片，不会启动 Claude，也不会直接生成 TaskRun。**

真实账号的登录 key 在本机私有文件 `workspace/evidence-preflight/state.json` 的 `accounts.owner.user_key`、`accounts.member.user_key`、`accounts.reviewer.user_key`、`accounts.outsider.user_key`。自行在本机查看，勿贴进聊天、截图或提交 Git。角色切换必须退出登录换 key；仅切换团队不是换账号。

## 3. 从正确工作树发起自然对话

先在终端执行，只读记录本次起点：

```sh
cd /Users/marcoskk7/github/TencentDB-Agent-Memory-evidence
git rev-parse HEAD
git status --short
git diff -- MemoryCore/src/metadata/router/v3-meta-schemas.ts
```

本次复核 HEAD 仍为 `39d52a3891278cdf27c6c9a4ad8eb0760c8aa339`，目标 schema 文件没有未提交差异，计划的 `user-create-validation.test.ts` 尚不存在。实际开测时以你重新检查的结果为准；若已经有人实现了任务，先停下来选择新的测试起点，不要覆盖别人修改。

工作树已有其他未提交改动。记录起始状态，不能把整个 `git diff HEAD` 都算作本轮或该 Skill 的产物；不要为测试清空工作树。

Claude Code 使用 owner 的用户 key，以及 **Proxy 地址**：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
read -rs "ANTHROPIC_AUTH_TOKEN?粘贴 evidence-owner 的 User Key（不回显）: "
export ANTHROPIC_AUTH_TOKEN
claude
```

上面 `read` 写法适用于当前 macOS 的 zsh。不要把真实 key 写进命令历史。已有启动配置若使用不同身份或端点，应先核对。`8420` 是 Core，不是 Claude 的聊天转发入口；Panel 的 API Key 页面当前可能因缺少 `proxy_endpoint` 显示 8420，不能照抄那个地址。

启动全新会话，不继续先前“你好/讲解”的会话。第一条直接发送：

> 修复用户创建接口接受纯空白用户名的问题。普通创建和带 Key 的创建要保持一致。请先补回归测试再做最小修改，运行测试并解释修改原因。保留工作区已有改动，不提交代码。

这条需求**没有指定 Skill，也没有复制它的详细规则**。是否能发现并使用已绑定的团队规范，正是测试内容。不要让 Claude 先读本文、前置记录或正文备份，否则无法区分知识来自团队资产通路还是本地文档。

出现选择框时：

1. “本次对话是否要关联团队资产？”选 **是，关联团队资产**。
2. 如果询问团队，选 **Evidence Acceptance**；只有一个可选团队时自动选择。
3. 如果询问 Agent，选 **Evidence Input Validation**；只有一个当前用户拥有的可选 Agent 时自动选择。
4. 任务选择中选刚创建的 **用户名输入校验验收**，不要选“本次不关联任务”或“跳过”。

**不要求固定出现三个框。** 前次 owner 只有一个团队和一个可选 Agent，因此只问“是否关联资产”和“选择任务”，两轮是正常分支。任务列表中的“本次不关联任务”是虚拟选项，不是新建的真实任务。

让 Claude 正常读取文件、补测试、改代码、执行测试；对工具权限按你实际认可的操作批准。不需要发送“生成 TaskRun”“写入 claim”“将 Skill 标为 used”等指令。

## 4. 观察自动生成了什么

环境开关生效后，完成会话初始化、进入具有完整身份和非空任务文本的主请求时，Proxy 自动创建或恢复 TaskRun。**Run 不以“已经使用 Skill”为创建前提**；同一未关闭的主会话通常复用原 Run，不是一条消息一个 Run。历史对话不会自动补录。

1. 保持 Panel 的 owner 身份，打开 **任务看板 → 本次任务 → 使用证据**，点击 **刷新**。
2. 点击最新的 Run，展开 **运行标识与环境**，核对 Task ID 和 Agent ID，记下 **运行 ID**。
3. 也可从 [证据与审核](http://127.0.0.1:5173/#/evidence) 的 **资产使用与审核** 列表找同一 Run；这里展示当前团队的运行，按任务文字、时间及运行详情确认，别误用旧 Run。
4. 在 Run 的 **资产使用与审核** 中找到 Skill `skl-pgTbAYpbquYG`，核对版本 `1` 和内容摘要：

```text
sha256:9abde84eb02f3fcab87a3ff6013d76e0191832bb2f133ef0298ecc8806331f35
```

5. 看 Claude 的实际工具记录是否通过已有 Skill 读取工具获取正文。当前系统给模型提供的读取入口叫 `skill_view`，可能表现为 Claude 执行工具请求，不一定是独立的顶层工具名。**Proxy 读了快照 / 页面显示“已注入”，不等于模型读了全文，更不等于使用。**
6. 等 Claude 本轮完成，再看 **Agent 使用声明 → 声明与关联引用** 和 **证据时间线**。应有模型根据实际工作产生的声明，以及能对应代码修改/测试调用的真实行为引用。界面详情不会自动持续刷新，可返回运行列表刷新后重新进入。

若 Claude 自行搜索并读到了本地验收文档或 `docs/evidence-input-validation.SKILL.md`，也应记录这个事实：只凭实现符合规则，已无法确认规则来自团队资产读取通路，不能将该轮当作干净的自动读取验收。

模型声明协议由 Proxy 自动提供；有效声明会被采集，不需要用户手填。若没有声明、声明 `not_used/uncertain`、没有可核验的工具关联，照实记为本次未证明使用，不能手工补一个 `used` 让流程变绿。模型最终普通文字说“使用了”也不能替代结构化声明。

上游 400 前，Proxy 可能已经建立 Run 或准备资产快照。因此“列表有 Run”不代表本轮编码完成，要继续核对实际行为。

版本边界：当前自动快照路径按固定资产 ID 获取当时版本，再记录 version/digest，**不是永久锁定 v1**；工具提示使用名称和版本读取。验收期间不要更新/创建同名 Skill。若 ID、版本、digest 不符，停止此次 v1 复用验收，不用外部读取脚本修饰成通过。固定绑定能固定候选资产，不能保证模型必然采用它。

## 5. reviewer 到哪里审核、怎么判断

如果声明已有可核验的行为关联，可以直接进行使用审核。若希望先看真实 diff 和独立采集的测试结果，先执行第 6 节，再回来审核。

1. Panel 退出 owner，换 **evidence-reviewer** 的 User Key 登录 `default`，选择 **Evidence Acceptance**。
2. 打开 **证据与审核 → 资产使用与审核 → 刚才记下的 Run**。也可以走 **任务看板 → 本次任务 → 使用证据**。
3. 在目标 Skill 下读 **Agent 使用声明**、关联引用、**关联验证**；对照 Claude 工具记录及实际源码/测试差异。不要只看“已注入”或模型口头总结。
4. 在该 Skill 下展开 **添加使用审核**，选择 **使用审核结论**：
   - **支持**：你实际核实了规则对代码或测试的影响；勾选该资产声明或其关联验证已映射的行为/变更，填写具体理由。
   - **不支持**：证据与使用声明矛盾，例如根本没有相应实现。
   - **不确定**：证据不足、没有可确认的关联，不能判断。
5. 点击 **提交使用审核**。出现“审核已记录，回执已刷新”，核对审核者 User ID 是 `usr-16oizbxo6h`。

“支持”必须至少勾选一条合法关联证据。没有选项或显示“尚未映射可审核的行为或变更”时，不是让你随便找一个测试凑数；记录为证据不足。当前行为摘要可能只有工具名/摘要哈希，Panel 并非完整代码审查器，必要时要对照本机 diff 和 Claude 工具记录才能作出判断。

审核理由应写你实际看到的事实，例如：哪次修改让两个 schema 先 trim 再检查非空，哪个测试覆盖了内部空格保留。只核实一部分就说明范围，不直接复制“全部通过”。

这里审核的是 **Skill 是否用于这一次 Run**。它与 Skill 原本的 `approved` 资产状态不同，也不是 **候选资产** 页里的批准操作。owner 虽有团队 admin 角色，本轮仍由独立 reviewer 审核，不用系统管理员代替。

## 6. 若还要验收“关联验证通过”：当前需要显式本地采集

这一段不是生成 Skill 使用记录，也不会创建 claim；它**真实执行一次测试**，将本机差异摘要和退出状态关联到第 4 节已经由模型产生的声明。

当前 Proxy 没有 Git 工作区，不会仅凭 Claude 说“测试通过”就得到可信退出码、代码 diff 或自动关闭 Run。**如果要求全程只对话和点 Panel、自动完成 diff/validation/关闭，现在的实现还不满足。** 不应把下面的手动采集包装成“全自动已完成”。

操作前，Claude 已完成代码修改，Run 仍为运行中，且有一个你确认与本次用户名测试相关的真实 claim。暂停对此工作树的其他编辑；采集期间文件变化会导致验证不通过。

1. 在 Run 中复制 **运行 ID**；在目标 Skill 的 **Agent 使用声明 → 声明与关联引用** 中复制 `claim_id`。没有 claim 就停在这里，不新建一个。
2. 在独立本地终端中设置以下环境变量；owner key 必须属于该 Run，不用 reviewer key：

```sh
export EVIDENCE_CORE_URL=http://127.0.0.1:8420
export EVIDENCE_SERVICE_ID=default
read -rs "EVIDENCE_GATEWAY_KEY?粘贴本地 Core 网关凭据（不回显）: "
export EVIDENCE_GATEWAY_KEY
read -rs "EVIDENCE_USER_KEY?粘贴 evidence-owner 的 User Key（不回显）: "
export EVIDENCE_USER_KEY
```

网关凭据是私有 `state.json` 中的 `gateway_key`，不是模型 API key。让终端的 `node`、`npm` 可用；本机已安装的路径是 `/Users/marcoskk7/.nvm/versions/node/v22.23.2/bin`。

3. 替换下列三个占位值，运行真实定向测试；基线使用第 3 节实际记录的 commit：

```sh
cd /Users/marcoskk7/github/TencentDB-Agent-Memory-evidence
node scripts/evidence-workspace.mjs \
  --repo /Users/marcoskk7/github/TencentDB-Agent-Memory-evidence \
  --run-id '替换为真实运行ID' \
  --claim-id '替换为该Skill的真实声明ID' \
  --base-ref '替换为开始前记录的commit' \
  -- npm --prefix MemoryCore test -- src/metadata/router/user-create-validation.test.ts
```

`npm --prefix MemoryCore test` 使用该包的 `vitest run` 脚本，因此测试路径相对于 MemoryCore。上面不是预填“passed”：采集器真的启动进程，只有退出码 0、没有超时且前后代码快照一致才记录通过。返回 1 表示测试/快照验证未通过；2 表示采集或上传失败。

4. 再用同一组参数，将最后的测试路径换成 `src/metadata`，运行 Skill 要求的范围回归。准备结束本次 Run 时，才在 `--` 之前加 `--close`。关闭发生在记录结果之后，测试失败也可能关闭，不代表任务成功；默认不加可继续修复、重新验证。
5. 刷新 Panel 的 Run，看 **关联验证** 中的实际退出码和结果，再按第 5 节审核。结束终端使用后清理凭据环境变量：

```sh
unset EVIDENCE_GATEWAY_KEY EVIDENCE_USER_KEY
```

采集器上传文件名、摘要和执行状态，不上传 patch 正文、命令参数或 stdout/stderr；也不改写 Skill/声明/人工审核。它会包含相对基线的所有未忽略差异，包括本轮之前已有的修改。审核时只能给核实过的两处 schema 和新增测试归因，不能据此声称其他 Evidence 改动也是 Skill 产物。`.gitignore` 中的配置、依赖不在快照中，这也不是完整环境或因果证明。

## 7. 本次结果怎么判定

| 你实际完成的步骤 | 应看到什么 | 不能据此推出什么 |
| --- | --- | --- |
| 创建 Task 卡片 | 任务看板出现卡片 | 不等于已有 TaskRun |
| 自然主请求进入已开启 Evidence 的 Proxy | 新建或恢复 Run | 不等于上游成功、Skill 已使用 |
| 固定 Skill 快照进入上下文 | 正确 ID/version/digest，召回/选择/注入记录 | 不等于模型读全文或执行规则 |
| 模型真实声明使用并关联行为 | “声明使用”为是 | “经审核使用”此时仍不能直接视为是 |
| reviewer 支持且引用合法证据，无未纠正的否定记录 | “经审核使用”为是 | 不自动代表测试通过 |
| 与该声明相关的真实验证通过 | “关联验证通过”为是 | 某个测试通过不等于 Skill 全部条款通过 |
| 单次使用审核及验证完成 | 没有对照时“有贡献证据”仍为否 | 不能把 used/validated 当因果贡献证明 |

额外角色检查：退出 reviewer，换 **evidence-member** 登录同团队，同一 Run 应可读，但不应出现可提交的使用审核表单；换 **evidence-outsider** 不应获得主团队 Run。记录实际结果，不使用 admin 代测。后者与已经发现的“外团队能读 Skill”是不同接口，不能互相替代验收。

手工保留本次：Task ID、Run ID、Skill ID/version/digest、真实 claim ID、基线 commit、实际工具/测试结果、审核人/理由及回执修订号。缺哪个就写“缺失”，不要用 demo 数据补齐。

## 8. 卡住时按现象定位

- **没有 Run**：先查 Evidence 是否在实际运行配置中启用、是否重启；再查是否跳过团队资产、用户/团队/Agent 身份、实例和 Proxy 地址。不是靠在提示词里加 Skill ID 解决。
- **选完两轮后 400**：这是初始化后的上游请求问题，不是缺少第三轮选择；也不能以先生成了 Run 认定成功。
- **有 Run 没有 Skill**：核对所选 Agent 和原固定绑定、资产 approved 状态、Core 实例；不要临时人工写 access。
- **有 Skill 没有有效声明/关联**：本次未证明自动采用，记录失败点；不要手填 claim。
- **没有“关联验证通过”**：检查是否真的运行并成功上传第 6 节采集，不能靠聊天总结代替。
- **无法选择支持**：先确认 reviewer 身份及合法证据关联；缺证据则不确定，不绕过校验。
- **Claude 已回答完，但 Run 还在运行中**：当前没有自动关闭集成；显式最终采集可关闭，不能把这误记成已自动完成。

实现依据：`MemoryProxy/src/anthropicHandler.ts`、`MemoryProxy/src/session/claude-code/evidence-runtime.ts`、`evidence-context.ts`，`MemoryPanel/web/src/components/evidence/`，`scripts/evidence-workspace.mjs`。本文核对了配置、代码和入口健康状态，没有代替操作者执行上述真实聊天或提交审核。
