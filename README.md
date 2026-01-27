# UI自动化测试工具

基于 [@browserbasehq/stagehand](https://github.com/browserbase/stagehand) 的UI自动测试工具，支持通过Excel文件定义测试用例，使用自然语言描述测试步骤和预期结果。

## 特性

- ✅ **Excel测试用例管理** - 使用Excel文件定义测试步骤和预期结果
- ✅ **自然语言测试** - 使用Stagehand的AI能力，用自然语言描述测试步骤
- ✅ **自动结果验证** - 自动验证预期结果是否匹配
- ✅ **多格式报告** - 生成控制台、Excel和HTML三种格式的测试报告
- ✅ **灵活配置** - 支持无头模式、调试模式等配置选项
- ✅ **操作记录模式** - 自动记录用户在浏览器上的操作，生成自然语言描述
- ✅ **网络请求拦截** - 根据Excel配置的API endpoint记录网络请求并mock response

## 安装

```bash
npm install
```

## 环境变量配置

项目使用 `.env` 文件来配置 LLM API Key。请按照以下步骤配置：

1. 复制 `.env.example` 文件为 `.env`：
```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，填入你的 API Key（至少配置一个）：
```env
# LLM API Key（选择一个或多个）
OPENAI_API_KEY=sk-your-openai-key-here
# ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here
# GOOGLE_GENERATIVE_AI_API_KEY=your-google-key-here

# 可选：指定使用的模型（如果不设置，将使用默认值）
# ANTHROPIC_MODEL=claude-3-5-sonnet-latest
# OPENAI_MODEL=gpt-4o
# GOOGLE_MODEL=gemini-1.5-flash
```

**注意：** 
- Stagehand 需要至少配置一个 LLM API Key 才能正常工作
- 如果未配置任何 API Key，程序会显示警告但仍会尝试运行
- 模型名称可以从环境变量读取，如果不设置则使用默认值：
  - Anthropic 默认: `claude-3-5-sonnet-latest`
  - OpenAI 和 Google: 由 Stagehand 自动检测
- `.env` 文件已添加到 `.gitignore`，不会被提交到版本控制

**支持的模型列表：**
- Anthropic: `claude-3-5-sonnet-latest`, `claude-3-5-sonnet-20240620`, `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219`, `claude-3-7-sonnet-latest`
- OpenAI: `gpt-4o`, `gpt-4o-mini`, `gpt-4.5-preview`, `o1`, `o1-mini` 等
- Google: `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.0-flash` 等

## 本地LLM部署（使用Ollama）

如果你想使用本地LLM模型而不是云API（节省成本、提高隐私、离线使用），可以使用Ollama部署本地模型。

### 1. 安装Ollama

**macOS:**
```bash
# 使用Homebrew安装
brew install ollama

# 或者访问 https://ollama.ai/download 下载安装包
```

**Linux/Windows:**
访问 https://ollama.ai/download 下载对应平台的安装包

### 2. 运行自动部署脚本

```bash
npm run llm:setup
```

脚本会自动：
- 检查Ollama是否已安装
- 启动Ollama服务
- 下载推荐的模型（默认: qwen2.5:3b）

### 3. 手动下载模型（可选）

如果你想使用其他模型，可以手动下载：

```bash
# 推荐的模型（按速度和性能排序）
ollama pull qwen2.5:3b      # 3B参数，中文支持好，速度快（推荐）
ollama pull llama3.2:3b     # 3B参数，速度快
ollama pull qwen2.5:7b      # 7B参数，中文支持好，性能更好
ollama pull llama3.1:8b     # 8B参数，性能好
ollama pull mistral:7b      # 7B参数，性能好

# 查看已安装的模型
ollama list
```

### 4. 安装依赖

确保已安装必要的依赖包：

```bash
npm install
```

这会自动安装 `ai` 和 `@ai-sdk/ollama` 包。

### 5. 配置环境变量

在 `.env` 文件中添加以下配置：

```env
# 启用本地LLM
USE_LOCAL_LLM=true

# Ollama服务地址（默认: http://localhost:11434）
OLLAMA_BASE_URL=http://localhost:11434

# Ollama模型名称（推荐: qwen2.5:3b）
OLLAMA_MODEL=qwen2.5:3b
```

**注意：** 新的实现方式使用 AI SDK 直接集成 Ollama，**不再需要代理服务器**，使用更简单！

### 6. 运行测试

现在可以直接运行测试了，系统会自动使用本地LLM：

```bash
npm run test -- --excel test-cases-template.xlsx
```

系统会自动：
- 检测Ollama服务是否运行
- 使用配置的模型
- 如果Ollama服务不可用，会显示友好的错误提示

### 本地LLM vs 云API

| 特性 | 本地LLM (Ollama) | 云API |
|------|-----------------|-------|
| 成本 | 免费 | 按使用量收费 |
| 隐私 | 数据不离开本地 | 数据发送到云端 |
| 速度 | 取决于硬件 | 通常较快 |
| 离线 | ✅ 支持 | ❌ 需要网络 |
| 模型选择 | 有限 | 更多选择 |
| 硬件要求 | 需要足够内存 | 无要求 |

**推荐配置：**
- 简单任务：使用 `qwen2.5:3b` 或 `llama3.2:3b`（需要约4GB内存）
- 复杂任务：使用 `qwen2.5:7b` 或 `llama3.1:8b`（需要约8GB内存）

### 工作原理

新的实现方式使用 **AI SDK** 和 **@ai-sdk/ollama** 直接集成 Ollama：

```typescript
import { ollama } from '@ai-sdk/ollama';
import { Stagehand } from '@browserbasehq/stagehand';

// 创建Ollama模型实例
const ollamaModel = ollama('qwen2.5:3b', {
  baseURL: 'http://localhost:11434'
});

// 传递给Stagehand
const stagehand = new Stagehand({
  env: 'LOCAL',
  llmClient: ollamaModel
});
```

这种方式：
- ✅ **更简单**：不需要额外的代理服务器
- ✅ **更直接**：直接使用AI SDK的Ollama集成
- ✅ **更高效**：减少了一层网络转发
- ✅ **更可靠**：使用官方推荐的集成方式

### 故障排查

**问题：无法连接到Ollama服务**
```bash
# 检查Ollama是否运行
curl http://localhost:11434/api/tags

# 如果未运行，启动Ollama
ollama serve
# 或者在macOS上打开Ollama应用
```

**问题：提示 "Ollama服务不可用"**
- 确保Ollama服务正在运行：`ollama serve`
- 检查 `.env` 文件中的 `OLLAMA_BASE_URL` 是否正确
- 确认模型已下载：`ollama list`

**问题：模型响应慢**
- 尝试使用更小的模型（如 `qwen2.5:3b`）
- 确保有足够的内存
- 关闭其他占用内存的应用

**问题：模型效果不好**
- 尝试使用更大的模型（如 `qwen2.5:7b`）
- 检查模型是否适合你的任务类型
- 注意：小模型在结构化输出方面可能不够稳定

## 快速开始

### 1. 创建测试用例模板

```bash
npm run test -- --template
```

这会创建一个 `test-cases-template.xlsx` 文件，包含示例测试用例格式。

### 2. 填写测试用例

打开生成的Excel文件，按照以下格式填写：

| 用例ID | 用例名称 | 测试URL | 测试步骤 | 预期结果 | 备注 |
|--------|----------|---------|----------|----------|------|
| TC-001 | 登录测试 | https://example.com/login | 打开登录页面<br>在用户名框输入 admin<br>在密码框输入 password<br>点击登录按钮 | 成功跳转到首页 | 验证正常登录流程 |

**测试步骤说明：**
- 每行一个步骤
- 使用自然语言描述操作，例如：
  - "点击登录按钮"
  - "在搜索框输入 关键词"
  - "选择下拉菜单中的 选项A"
  - "等待页面加载完成"

### 3. 运行测试

```bash
npm run test -- --excel test-cases-template.xlsx
```

### 4. 使用操作记录模式

操作记录模式允许你手动在浏览器中操作，系统会自动记录你的操作并生成自然语言描述：

```bash
# 启动记录模式（会打开浏览器）
npm run start -- --record --record-url https://example.com

# 启动记录模式并配置API mock
npm run start -- --record --record-url https://example.com --api-config api-config.xlsx

# 记录模式会在你按 Ctrl+C 时停止并保存结果
```

记录的结果会保存为JSON文件，包含：
- 所有操作的自然语言描述
- 网络请求和响应
- 可以导出为测试步骤格式

### 5. 配置API Mock（简化版）

**新方式：在测试用例表中直接配置API URL，系统会自动捕获真实的请求和响应**

在Excel测试用例表中，新增了三列：
- **API URL**（第7列）：填写需要关注的API URL，支持多个URL（用换行或分号分隔）
- **API Request**（第8列）：记录操作时自动填充Zod校验规则（作为预期结果，用于验证请求）
- **API Response**（第9列）：记录操作时自动填充真实的响应数据（仅记录，不校验）

**Excel格式示例：**

| 用例ID | 用例名称 | 测试URL | 测试步骤 | 预期结果 | 备注 | API URL | API Request | API Response |
|--------|----------|---------|----------|----------|------|---------|-------------|--------------|
| TC-001 | 登录测试 | https://example.com/login | ... | ... | ... | /api/login<br>/api/user | （自动填充Zod） | （自动填充） |

**工作流程：**
1. 在Excel测试用例表的"API URL"列填写需要关注的API URL（一个测试用例可对应多个API）
2. 启动记录模式，手动操作浏览器
3. 系统会自动捕获这些API的真实请求和响应
4. 停止记录时，会自动：
   - 将Zod校验规则写入"API Request"列（用于后续测试时验证请求是否符合预期）
   - 将真实的响应数据写入"API Response"列（仅记录，不用于校验）

**测试执行时的验证：**
- 运行测试时，系统会使用"API Request"列中的Zod schema验证实际的API请求
- 如果请求不符合Zod schema，测试会失败
- "API Response"列的数据仅用于记录，不会进行校验

**API URL格式：**
- 单个API：`/api/login`
- 多个API（换行分隔）：
  ```
  /api/login
  /api/user
  ```
- 多个API（分号分隔）：`/api/login;/api/user`

**使用方法：**
```bash
# 1. 在Excel测试用例表的"API URL"列填写API地址
# 2. 启动记录模式，操作浏览器
npm run start -- --record --record-url https://example.com --api-config test-cases.xlsx

# 3. 停止记录后，Excel文件会自动填充：
#    - "API Request"列：Zod校验规则（用于后续测试验证请求）
#    - "API Response"列：真实的响应数据（仅记录）

# 4. 运行测试时，系统会使用"API Request"列中的Zod schema验证实际的API请求
```

## 命令行选项

```bash
node dist/index.js [选项]

选项:
  --excel, -e <文件>        Excel测试用例文件路径 (测试模式必需)
  --output, -o <目录>        报告输出目录 (默认: ./reports)
  --headless <true|false>    是否无头模式 (默认: true)
  --debug, -d               启用调试模式
  --template, -t             创建Excel模板文件
  --record, -r               启动操作记录模式
  --record-url <URL>          记录模式：初始URL（可选）
  --record-output <文件>      记录模式：输出文件路径 (默认: ./recorded-actions.json)
  --api-config <文件>        API配置Excel文件（用于mock，测试和记录模式都支持）
  --help, -h                 显示帮助信息
```

## 示例

### 创建模板
```bash
npm run test -- --template
```

### 运行测试（默认配置）
```bash
npm run test -- --excel my-test-cases.xlsx
```

### 运行测试并指定输出目录
```bash
npm run test -- --excel my-test-cases.xlsx --output ./test-results
```

### 启用调试模式（显示浏览器）
```bash
npm run test -- --excel my-test-cases.xlsx --headless false --debug
```

### 使用操作记录模式
```bash
# 基本记录模式（只记录操作，不关注API）
npm run start -- --record --record-url https://example.com

# 记录模式并自动捕获API请求/响应（推荐）
# 1. 先在Excel测试用例表的"API URL"列填写需要关注的API URL
# 2. 启动记录模式，系统会自动捕获这些API的真实请求和响应
npm run start -- --record --record-url https://example.com --api-config test-cases.xlsx --headless false

# 停止记录后：
# - Excel文件的"API Response"列会自动填充真实的响应数据
# - 同时会生成 recorded-actions.json (包含所有操作和网络请求)
# - 同时会生成 recorded-actions-steps.txt (操作步骤文本)
# - 同时会生成 recorded-actions-mock-config.json (自动生成的mock配置)
```

### 运行测试并使用API mock
```bash
npm run start -- --excel test-cases.xlsx --api-config api-config.xlsx
```

## Excel文件格式

Excel文件应包含以下列（第一行为表头）：

1. **用例ID** - 测试用例的唯一标识符
2. **用例名称** - 测试用例的名称
3. **测试URL** - 要测试的网页URL
4. **测试步骤** - 测试步骤，每行一个步骤，使用自然语言描述
5. **预期结果** - 测试的预期结果描述
6. **备注** - 可选的备注信息

### 测试步骤示例

```
打开登录页面
在用户名框输入 admin
在密码框输入 password123
点击登录按钮
等待页面跳转
```

## 测试报告

测试完成后，会在输出目录（默认 `./reports`）生成三种格式的报告：

1. **控制台报告** - 在终端显示测试结果
2. **Excel报告** - 详细的Excel格式报告，包含所有测试结果
3. **HTML报告** - 美观的HTML格式报告，可在浏览器中查看

报告文件命名格式：`test-report-YYYY-MM-DDTHH-mm-ss.xlsx/html`

## 工作原理

1. **解析Excel** - 读取Excel文件，解析测试用例
2. **初始化Stagehand** - 启动浏览器自动化环境
3. **执行测试步骤** - 使用Stagehand的 `act()` 方法执行自然语言描述的测试步骤
4. **验证结果** - 使用 `observe()` 和 `extract()` 方法验证预期结果
5. **生成报告** - 生成多格式测试报告

## 技术栈

- [TypeScript](https://www.typescriptlang.org/) - 类型安全的 JavaScript
- [@browserbasehq/stagehand](https://github.com/browserbase/stagehand) - AI驱动的浏览器自动化框架
- [exceljs](https://github.com/exceljs/exceljs) - Excel文件读写
- [zod](https://github.com/colinhacks/zod) - 数据验证
- [chalk](https://github.com/chalk/chalk) - 终端颜色输出

## 开发

### 构建项目

```bash
npm run build
```

这将 TypeScript 代码编译到 `dist` 目录。

### 开发模式

```bash
npm run dev
```

这将启动 TypeScript 编译器监视模式，自动重新编译更改的文件。

## 注意事项

1. **API密钥** - Stagehand可能需要配置API密钥，请参考 [Stagehand文档](https://github.com/browserbase/stagehand)
2. **网络环境** - 确保能够访问要测试的网站
3. **测试步骤描述** - 使用清晰、具体的自然语言描述测试步骤，有助于AI准确理解
4. **预期结果验证** - 预期结果描述要具体，便于自动验证

## 许可证

MIT
