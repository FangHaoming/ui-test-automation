# 本地LLM部署脚本

本目录包含用于部署和使用本地LLM模型的脚本。

## 文件说明

### `setup-ollama.sh`
Ollama自动部署脚本，用于：
- 检查Ollama是否已安装
- 启动Ollama服务
- 下载推荐的模型

**使用方法：**
```bash
npm run llm:setup
# 或
bash scripts/setup-ollama.sh
```

### `local-llm-server.js`
本地LLM代理服务，将Ollama API转换为OpenAI兼容格式。

**功能：**
- 接收OpenAI格式的API请求
- 转换为Ollama API格式
- 调用Ollama服务
- 将响应转换回OpenAI格式

**使用方法：**
```bash
npm run llm:server
# 或
node scripts/local-llm-server.js
```

**环境变量：**
- `OLLAMA_BASE_URL`: Ollama服务地址（默认: http://localhost:11434）
- `OLLAMA_MODEL`: Ollama模型名称（默认: qwen2.5:3b）
- `LOCAL_LLM_PORT`: 代理服务端口（默认: 3001）

## 快速开始

1. **安装Ollama**
   ```bash
   # macOS
   brew install ollama
   
   # 或访问 https://ollama.ai/download
   ```

2. **运行部署脚本**
   ```bash
   npm run llm:setup
   ```

3. **配置环境变量**
   在 `.env` 文件中添加：
   ```env
   USE_LOCAL_LLM=true
   OLLAMA_MODEL=qwen2.5:3b
   LOCAL_LLM_URL=http://localhost:3001
   ```

4. **启动代理服务**
   ```bash
   npm run llm:server
   ```

5. **运行测试**
   在另一个终端窗口运行测试：
   ```bash
   npm run test -- --excel test-cases-template.xlsx
   ```

## 推荐模型

| 模型 | 参数量 | 内存需求 | 速度 | 适用场景 |
|------|--------|----------|------|----------|
| qwen2.5:3b | 3B | ~4GB | 快 | 简单任务，中文支持好 |
| llama3.2:3b | 3B | ~4GB | 快 | 简单任务 |
| qwen2.5:7b | 7B | ~8GB | 中等 | 复杂任务，中文支持好 |
| llama3.1:8b | 8B | ~8GB | 中等 | 复杂任务 |
| mistral:7b | 7B | ~8GB | 中等 | 复杂任务 |

## 故障排查

### Ollama服务未运行
```bash
# 检查服务状态
curl http://localhost:11434/api/tags

# 启动服务
ollama serve
```

### 代理服务无法连接Ollama
- 检查 `OLLAMA_BASE_URL` 是否正确
- 确保Ollama服务正在运行
- 检查防火墙设置

### 模型响应慢
- 使用更小的模型
- 确保有足够的内存
- 关闭其他占用资源的应用
