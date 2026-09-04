import { describe, expect, it } from "vitest";
import { userCreateSchema, userCreateWithKeySchema } from "./v3-meta-schemas.js";

/**
 * 回归：用户创建接口接受纯空白 username（空格 / Tab / 换行 / 全角空格）。
 *
 * 两个创建接口（普通 /user/create 与带 Key /user/create-with-key）必须使用相同规则：
 *   1. username 必须是字符串；缺失、null、数字、布尔、数组、对象均拒绝，不做类型强制转换；
 *   2. trim 后非空；"" 及纯空白组成的字符串均拒绝；
 *   3. 合法值返回 trim 后的用户名，保留大小写、中文与内部空格；
 *   4. user_key 按原值保留，不对密钥做 trim 或大小写转换。
 */
interface UsernameCase {
  label: string;
  username: unknown; // undefined 表示字段缺失
  accepted: boolean;
  expected?: string;
}

const usernameCases: UsernameCase[] = [
  // 拒绝：缺失 / 非字符串（不做类型强制转换）
  { label: "username 缺失", username: undefined, accepted: false },
  { label: "null", username: null, accepted: false },
  { label: "数字", username: 123, accepted: false },
  { label: "布尔", username: true, accepted: false },
  { label: "数组", username: [], accepted: false },
  { label: "对象", username: {}, accepted: false },
  // 拒绝：空串与纯空白
  { label: '空串 ""', username: "", accepted: false },
  { label: '" \\t\\n"', username: " \t\n", accepted: false },
  { label: '全角空格 "\\u3000"', username: "　", accepted: false },
  // 接受：trim 后返回，保留大小写 / 中文 / 内部空格
  { label: '" Alice " → "Alice"', username: " Alice ", accepted: true, expected: "Alice" },
  { label: '" 张 三 " → "张 三"', username: " 张 三 ", accepted: true, expected: "张 三" },
  { label: '"MiXeD" → "MiXeD"', username: "MiXeD", accepted: true, expected: "MiXeD" },
];

/** username 为 undefined 表示字段缺失（不写入 body）。 */
function bodyOf(username: unknown, withKey: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (username !== undefined) body.username = username;
  if (withKey) body.user_key = "sk-test-123";
  return body;
}

describe.each([
  { name: "userCreateSchema", schema: userCreateSchema, withKey: false },
  { name: "userCreateWithKeySchema", schema: userCreateWithKeySchema, withKey: true },
])("$name username 校验", ({ schema, withKey }) => {
  it.each(usernameCases)("$label → $accepted", ({ username, accepted, expected }) => {
    const result = schema.safeParse(bodyOf(username, withKey));
    if (accepted) {
      expect(result.success, result.success ? "" : JSON.stringify(result.error)).toBe(true);
      if (!result.success) return;
      expect(result.data.username).toBe(expected);
    } else {
      expect(result.success).toBe(false);
    }
  });
});

describe("userCreateWithKeySchema user_key 透传", () => {
  it("user_key 按原值保留，不做 trim / 大小写转换", () => {
    const inputKey = "  Sk-Test_AbC-123  ";
    const result = userCreateWithKeySchema.safeParse({ username: "Alice", user_key: inputKey });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.user_key).toBe(inputKey);
  });
});
