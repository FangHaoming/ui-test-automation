#!/bin/bash

# Ollama 本地LLM部署脚本
# 用于在macOS上安装和配置Ollama

set -e

echo "=========================================="
echo "Ollama 本地LLM部署脚本"
echo "=========================================="
echo ""

# 检查是否已安装Ollama
if command -v ollama &> /dev/null; then
    echo "✓ Ollama 已安装"
    ollama --version
else
    echo "正在安装 Ollama..."
    
    # macOS安装方式
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "检测到 macOS 系统"
        echo "请访问 https://ollama.ai/download 下载并安装 Ollama"
        echo "或者使用 Homebrew 安装:"
        echo "  brew install ollama"
        echo ""
        read -p "是否已安装 Ollama? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "请先安装 Ollama，然后重新运行此脚本"
            exit 1
        fi
    else
        echo "请访问 https://ollama.ai/download 下载并安装 Ollama"
        exit 1
    fi
fi

# 检查Ollama服务是否运行
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "✓ Ollama 服务正在运行"
else
    echo "启动 Ollama 服务..."
    # 尝试启动Ollama（macOS）
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open -a Ollama 2>/dev/null || ollama serve &
        sleep 3
    else
        ollama serve &
        sleep 3
    fi
    
    # 再次检查
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "✓ Ollama 服务已启动"
    else
        echo "✗ 无法启动 Ollama 服务"
        echo "请手动启动 Ollama 应用或运行: ollama serve"
        exit 1
    fi
fi

# 推荐的模型列表
echo ""
echo "推荐的模型（按大小和性能排序）:"
echo "  1. llama3.2:3b    - 3B参数，速度快，适合简单任务"
echo "  2. llama3.2:1b    - 1B参数，最快，适合简单任务"
echo "  3. qwen2.5:7b     - 7B参数，中文支持好"
echo "  4. qwen2.5:3b     - 3B参数，中文支持好，速度快"
echo "  5. mistral:7b     - 7B参数，性能好"
echo "  6. llama3.1:8b    - 8B参数，性能好"
echo ""
read -p "请输入要下载的模型名称（直接回车使用默认: qwen2.5:3b）: " model_name
model_name=${model_name:-qwen2.5:3b}

echo ""
echo "正在下载模型: $model_name"
echo "这可能需要几分钟到几十分钟，取决于模型大小和网络速度..."
ollama pull "$model_name"

echo ""
echo "=========================================="
echo "✓ 部署完成！"
echo "=========================================="
echo ""
echo "已安装的模型:"
ollama list

echo ""
echo "测试模型:"
echo "  ollama run $model_name '你好，请介绍一下你自己'"
echo ""
echo "下一步:"
echo "  1. 配置 .env 文件，设置 LOCAL_LLM_URL=http://localhost:11434"
echo "  2. 设置 LOCAL_LLM_MODEL=$model_name"
echo "  3. 运行项目测试本地LLM是否正常工作"
echo ""
