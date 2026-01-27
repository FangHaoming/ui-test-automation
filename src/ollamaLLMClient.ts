/**
 * Ollama LLM客户端
 * 使用AI SDK的Ollama集成，为Stagehand v3提供本地LLM支持
 * 
 * 参考: https://stagehand.readme-i18n.com/examples/custom_llms
 * 参考: https://github.com/browserbase/stagehand/blob/v2/examples/external_clients/aisdk.ts
 */

import { ollama } from 'ai-sdk-ollama';
import { getOllamaConfig, checkOllamaService } from './ollamaClient.js';
import { AISdkClient } from './aisdkClient.js';
import chalk from 'chalk';

/**
 * 创建用于Stagehand的Ollama LLM客户端
 * 
 * 使用 AISdkClient 包装器将 AI SDK 的 LanguageModel 适配到 Stagehand 的接口
 * 
 * 注意：根据 Stagehand 文档，小模型在 Ollama 上可能难以获得一致的结构化输出
 * 建议使用较大的模型（如 qwen2.5:7b 或更大）以获得更好的效果
 */
export async function createOllamaLLMClient(): Promise<AISdkClient> {
  const config = getOllamaConfig();
  
  // 检查Ollama服务是否可用
  const isAvailable = await checkOllamaService(config.baseURL);
  if (!isAvailable) {
    console.warn(chalk.yellow(`⚠️  警告: 无法连接到Ollama服务 (${config.baseURL})`));
    console.warn(chalk.yellow('   请确保Ollama服务正在运行: ollama serve'));
    throw new Error(`Ollama服务不可用: ${config.baseURL}`);
  }
  
  console.log(chalk.cyan(`✓ 使用Ollama模型: ${config.model} (${config.baseURL})`));
  
  // 直接使用 ollama provider（根据参考代码）
  // 注意：ollama() 不支持在调用时传入 baseURL，默认使用 http://127.0.0.1:11434
  // 如果 baseURL 不是默认值，可能需要通过环境变量或其他方式配置
  const model = ollama(config.model, {
    // 启用结构化输出模式，这对 Stagehand 很重要
    structuredOutputs: true,
    // 启用可靠的对象生成
    reliableObjectGeneration: true,
    // 配置对象生成选项以提高稳定性
    objectGenerationOptions: {
      maxRetries: 3,
      attemptRecovery: true,
      useFallbacks: true,
      fixTypeMismatches: true,
      enableTextRepair: true,
    },
  });
  
  // 验证模型对象是否有效
  if (!model) {
    throw new Error('无法创建 Ollama 模型实例');
  }
  
  // 检查模型对象的关键属性
  if (typeof model !== 'object') {
    throw new Error(`模型实例类型不正确: ${typeof model}`);
  }
  
  // 详细打印模型对象信息用于调试
  console.log(chalk.gray(`   模型对象类型: ${typeof model}`));
  const modelKeys = Object.keys(model || {});
  console.log(chalk.gray(`   模型对象键: ${modelKeys.join(', ')}`));
  
  // 检查关键属性
  const modelAny = model as any;
  console.log(chalk.gray(`   modelId: ${modelAny?.modelId || modelAny?.id || 'undefined'}`));
  console.log(chalk.gray(`   provider: ${modelAny?.provider || 'undefined'}`));
  console.log(chalk.gray(`   specificationVersion: ${modelAny?.specificationVersion || 'undefined'}`));
  
  // 使用 AISdkClient 包装器（根据参考代码）
  const client = new AISdkClient({ model });
  console.log(chalk.cyan('✓ 已创建 AISdkClient 包装器'));
  
  return client;
}
