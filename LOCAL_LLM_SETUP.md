# 本地LLM部署快速指南

本指南将帮助你快速部署和使用本地LLM模型来运行UI自动化测试。

## 🚀 快速开始（5分钟）

### 步骤1: 安装Ollama

**macOS:**
```bash
brew install ollama
```

**其他平台:**
访问 https://ollama.ai/download 下载安装

### 步骤2: 运行自动部署脚本

```bash
npm run llm:setup
```

脚本会自动：
- ✅ 检查Ollama安装
- ✅ 启动Ollama服务
- ✅ 下载推荐模型（qwen2.5:3b）

### 步骤3: 安装依赖

```bash
npm install
```

这会安装 `ai` 和 `@ai-sdk/ollama` 包。

### 步骤4: 配置环境变量

创建或编辑 `.env` 文件：

```env
# 启用本地LLM
USE_LOCAL_LLM=true

# Ollama配置
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b
```

**注意：** 新版本使用 AI SDK 直接集成，**不再需要代理服务器**！

### 步骤5: 运行测试

直接运行测试即可：

```bash
npm run test -- --excel test-cases-template.xlsx
```

系统会自动检测并使用本地LLM。

## 📋 完整工作流程

```bash
# 1. 确保Ollama服务运行
ollama serve

# 2. 直接运行测试（无需代理服务器）
npm run test -- --excel test-cases-template.xlsx
```

## 🎯 推荐模型选择

| 场景 | 推荐模型 | 内存需求 |
|------|----------|----------|
| 简单任务，快速测试 | `qwen2.5:3b` | ~4GB |
| 中文任务 | `qwen2.5:3b` 或 `qwen2.5:7b` | 4-8GB |
| 复杂任务 | `qwen2.5:7b` 或 `llama3.1:8b` | ~8GB |

## 🔧 常用命令

```bash
# 查看已安装的模型
ollama list

# 下载新模型
ollama pull qwen2.5:7b

# 测试模型
ollama run qwen2.5:3b "你好"

# 检查Ollama服务状态
curl http://localhost:11434/api/tags

# 启动Ollama服务（如果未运行）
ollama serve
```

## ❓ 常见问题

### Q: 代理服务无法连接Ollama？
A: 确保Ollama服务正在运行：
```bash
ollama serve
# 或打开Ollama应用（macOS）
```

### Q: 模型响应很慢？
A: 
- 使用更小的模型（如 `qwen2.5:3b`）
- 确保有足够的内存
- 关闭其他占用资源的应用

### Q: 如何切换模型？
A: 修改 `.env` 文件中的 `OLLAMA_MODEL`，然后重启代理服务。

### Q: 可以同时使用本地LLM和云API吗？
A: 可以，但需要修改代码逻辑。默认情况下，如果设置了 `USE_LOCAL_LLM=true`，会优先使用本地LLM。

## 📚 更多信息

- 详细文档: 查看 [README.md](./README.md) 中的"本地LLM部署"章节
- 脚本说明: 查看 [scripts/README.md](./scripts/README.md)
- Ollama文档: https://ollama.ai/docs

## 💡 提示

1. **首次使用**: 建议先用小模型（如 `qwen2.5:3b`）测试，确认一切正常后再尝试大模型
2. **内存管理**: 确保有足够内存运行模型，否则可能影响性能
3. **后台运行**: 可以使用 `nohup` 或 `screen` 让代理服务在后台运行
4. **性能优化**: 如果测试任务简单，使用小模型即可，速度更快
