---
name: web-assertions-json
description: 根据给定的“预期结果”和当前页面的可访问性元素、页面 URL 生成固定 JSON 格式的断言数据。用于 Web 自动化/测试场景，当用户提到预期结果、断言 JSON、cursor-ide-browser 页面元素或需要为步骤生成断言时使用。支持 URL 跳转、文本包含和可访问性元素存在三类断言。
---

# Web 断言 JSON 生成

## Instructions

当需要“根据预期结果 + 当前页面信息（URL + 可访问性元素）生成断言 JSON”时，按以下流程执行：

1. **理解预期结果**
   - 从用户给出的“预期结果”自然语言中，提取核心判断逻辑，例如：
     - “跳转到 https://example.com”
     - “页面中出现文案‘支付成功’”
     - “存在名称为‘提交’的按钮”

2. **结合页面信息做合理映射**
   - 使用（或假定已有）当前页面的：
     - 页面 URL
     - 可访问性元素信息（如 role / name / aria-label 等）
   - 用这些信息来**消歧义**，选择最合理的断言目标：
     - URL 断言：优先使用真实页面 URL
     - 文本断言：确认文本确实在页面中出现
     - 元素断言：用 role + name 描述可访问性元素

3. **生成固定结构的 JSON**
   - 输出 **合法 JSON**，不要包含注释或多余字段。
   - 单个预期结果可以输出单个断言对象；
   - 多个预期结果可以输出断言对象数组。

4. **只使用约定的字段**
   - 不要随意发明新的字段名。
   - 未被明确要求的复杂匹配方式（正则、模糊匹配等）一律不用，保持简单、可预测。

## JSON 格式说明

### 通用规则

- 顶层可以是：
  - 单个断言对象，例如：

    ```json
    {
      "type": "url",
      "value": "https://example.com"
    }
    ```

  - 或断言对象数组，用于多个断言，例如：

    ```json
    [
      {
        "type": "url",
        "value": "https://example.com"
      },
      {
        "type": "text",
        "value": "支付成功",
        "match": "include"
      }
    ]
    ```

- 所有字符串必须使用双引号，保证是**合法 JSON**。

### 1. URL 断言

**用途**：验证是否“跳转到某个 URL / 停留在某个 URL”。

**结构：**

```json
{
  "type": "url",
  "value": "https://example.com"
}
```

- `type`: 固定为 `"url"`
- `value`: 期望的完整 URL 字符串

**映射规则：**
- 当预期类似于“跳转到 http://example.com”“当前 URL 为 https://foo.bar/path”时，生成上述结构。
- 如预期给出相对路径，而你有完整页面 URL，可补全为完整 URL；如果无法确定，直接使用预期中给出的 URL 文本。

### 2. 文本包含断言

**用途**：验证页面包含某一段文本。

**结构：**

```json
{
  "type": "text",
  "value": "支付成功",
  "match": "include"
}
```

- `type`: 固定为 `"text"`
- `value`: 期望在页面上出现的文本内容
- `match`: 字符串匹配方式，当前统一使用 `"include"` 表示“包含”

**映射规则：**
- 当预期类似“看到文案‘支付成功’”“页面出现‘登录成功’提示”等，使用 `type: "text"`。
- 默认使用 `"match": "include"`，不区分大小写、不做复杂匹配，保持简单。

### 3. 可访问性元素存在断言

**用途**：验证页面上存在某个可访问性元素（基于 role + name）。

**结构：**

```json
{
  "type": "element",
  "query": {
    "role": "button",
    "name": "提交"
  }
}
```

- `type`: 固定为 `"element"`
- `query`: 描述如何在可访问性树中找到该元素
  - `role`: 可选，元素的可访问性角色（如 `"button"`, `"link"`, `"heading"` 等）
  - `name`: 可选，元素的可访问性名称 / 可见文本（如 `"提交"`, `"确认支付"` 等）

**映射规则：**
- 当预期类似“页面上有一个‘提交’按钮”“存在‘下一步’链接”等：
  - 优先设置 `role` 为 `"button"` / `"link"` 等常见角色；
  - `name` 使用预期中提到的关键文字。
- 如果预期只说“存在某个按钮”但没有名称，可以只填 `role`：

  ```json
  {
    "type": "element",
    "query": {
      "role": "button"
    }
  }
  ```

## Examples

### 示例 1：URL 跳转

**预期结果：**

> 跳转到 http://example.com

**JSON：**

```json
{
  "type": "url",
  "value": "http://example.com"
}
```

### 示例 2：文本包含

**预期结果：**

> 页面中出现“支付成功”的提示

**JSON：**

```json
{
  "type": "text",
  "value": "支付成功",
  "match": "include"
}
```

### 示例 3：可访问性按钮存在

**预期结果：**

> 能看到一个名称为“提交订单”的按钮

**JSON：**

```json
{
  "type": "element",
  "query": {
    "role": "button",
    "name": "提交订单"
  }
}
```

### 示例 4：多个断言同时存在

**预期结果：**

> 成功提交后跳转到 https://example.com/success，并看到“支付成功”提示

**JSON：**

```json
[
  {
    "type": "url",
    "value": "https://example.com/success"
  },
  {
    "type": "text",
    "value": "支付成功",
    "match": "include"
  }
]
```

