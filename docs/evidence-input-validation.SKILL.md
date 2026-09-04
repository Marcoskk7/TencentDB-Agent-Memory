---
name: evidence-username-validation-v1
description: 为 MemoryCore 用户创建接口实施可重复的用户名输入校验，并以真实测试及 diff 证明具体规则是否被使用。
---

# 用户名输入校验 v1

适用范围：MemoryCore 的 `/v3/meta/user/create` 和
`/v3/meta/user/create-with-key`，即 `userCreateSchema` 与
`userCreateWithKeySchema`。这是待实现的验收任务，不代表当前代码已有这些行为。

## 确定性规则

1. username 必须是字符串；拒绝缺失、null、数字、布尔、数组、对象，不做类型强制转换。
2. 字符串先执行 JavaScript `trim()`，再判定非空；空串、空格、制表符、换行及全角空格组成的字符串均拒绝。
3. 接受合法值时返回 trim 后的用户名；保留大小写、中文和内部空格。
4. 两个创建接口使用相同规则。不要改动其他实体的通用 nonEmpty、init-admin、user_id 或 user_key 规则，不新增用户名长度限制。
5. `user_key` 必须按原值保留，不对密钥做 trim、大小写转换或打印。

## 验收输入与结果

| 输入 username | 结果 |
| --- | --- |
| 缺失、null、123、true、[]、{} | 拒绝 |
| `""`、`" \t\n"`、`"\u3000"` | 拒绝 |
| `" Alice "` | `"Alice"` |
| `" 张 三 "` | `"张 三"` |
| `"MiXeD"` | `"MiXeD"` |

## 实施与验证

1. 在已记录基线的 evidence Git 工作树操作，先检查目标文件是否有用户改动。
2. 在 `MemoryCore/src/metadata/router/user-create-validation.test.ts` 增加表驱动测试，分别覆盖两个 schema；先运行并记录失败。
3. 仅修改 `MemoryCore/src/metadata/router/v3-meta-schemas.ts` 中上述两个 username 字段，完成最小实现。合法 create-with-key 请求须附带测试专用 key；另验证输出 key 与输入完全一致。
4. 在 MemoryCore 目录执行 `npm exec -- vitest run src/metadata/router/user-create-validation.test.ts`，再执行 `npm exec -- vitest run src/metadata`。记录实际退出码，不虚构通过结果。
5. 检查 diff 只含两个 username 字段及相关测试，不修改账号、权限、数据库或其他未提交代码。

## Evidence 边界

只读取当前会话绑定的这个 Skill 的指定版本。用固定 Skill ID 和版本读取，并核对正文 SHA-256；不以语义搜索结果、同名资产或“最新版本”替代。
只有这些规则实际影响代码或测试时才声明 used，并引用该 Run 的真实 access_id 与行为/diff；仅仅读到 Skill 不等于使用。禁止代替 reviewer 提交支持、伪造退出码或声称 contributed。
