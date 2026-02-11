/**
 * API Key 检查与 Stagehand LLM 配置
 */

import chalk from 'chalk';
import { AISdkClient } from '../ai/aisdkClient.js';
import { OpenaiProvider } from '../ai/providers/openai-provider.js';
import { OllamaProvider } from '../ai/providers/ollama-provider.js';

/**
 * 检查 API 密钥配置并输出提示
 */
export function checkApiKeys(): void {
  const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';

  if (useLocalLLM) {
    const localLLMUrl = process.env.LOCAL_LLM_URL || 'http://localhost:3001';
    const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
    console.log(chalk.cyan('✓ 使用本地LLM模式'));
    console.log(chalk.gray(`   本地LLM服务: ${localLLMUrl}`));
    console.log(chalk.gray(`   Ollama模型: ${ollamaModel}`));

    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'local-llm-key';
    }
    if (localLLMUrl) {
      process.env.OPENAI_BASE_URL = localLLMUrl;
    }
    return;
  }

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!hasOpenAI && !hasAnthropic && !hasGoogle) {
    console.warn(chalk.yellow('\n⚠️  警告: 未检测到任何 LLM API Key'));
    console.warn(chalk.yellow('   请在 .env 文件中配置以下环境变量之一:'));
    console.warn(chalk.yellow('   - OPENAI_API_KEY'));
    console.warn(chalk.yellow('   - ANTHROPIC_API_KEY'));
    console.warn(chalk.yellow('   - GOOGLE_GENERATIVE_AI_API_KEY'));
    console.warn(chalk.yellow('   或者设置 USE_LOCAL_LLM=true 使用本地LLM'));
    console.warn(chalk.yellow('   参考 .env.example 文件进行配置\n'));
  } else {
    const configuredKeys: string[] = [];
    if (hasOpenAI) {
      configuredKeys.push('OpenAI');
      const openAiKey = process.env.OPENAI_API_KEY || '';
      if (!openAiKey.startsWith('sk-') && openAiKey !== 'local-llm-key') {
        console.warn(chalk.yellow('⚠️  警告: OPENAI_API_KEY 格式可能不正确（应以 sk- 开头）'));
      }
    }
    if (hasAnthropic) {
      configuredKeys.push('Anthropic');
      const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
      if (!anthropicKey.startsWith('sk-ant-')) {
        console.warn(chalk.yellow('⚠️  警告: ANTHROPIC_API_KEY 格式可能不正确（应以 sk-ant- 开头）'));
      } else {
        console.log(chalk.gray(`   Anthropic API Key: ${anthropicKey.substring(0, 12)}...`));
      }
    }
    if (hasGoogle) configuredKeys.push('Google');
    console.log(chalk.green(`✓ 检测到 API Key: ${configuredKeys.join(', ')}`));
  }
}

export interface BuildStagehandConfigOptions {
  headless?: boolean;
  debug?: boolean;
}

export interface BuildStagehandConfigResult {
  stagehandConfig: Record<string, any>;
  llmClient: AISdkClient | null;
}

/**
 * 根据环境变量构建 Stagehand 配置与可选的 LLM 客户端
 */
export function buildStagehandConfig(options: BuildStagehandConfigOptions): BuildStagehandConfigResult {
  const { headless, debug } = options;
  const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const stagehandConfig: Record<string, any> = {
    env: 'LOCAL',
    verbose: debug ? 2 : 1,
    localBrowserLaunchOptions: { headless },
    domSettleTimeout: 0,
  };

  let llmClient: AISdkClient | null = null;

  if (useLocalLLM) {
    try {
      llmClient = new AISdkClient({
        model: OllamaProvider.languageModel(process.env.OLLAMA_MODEL || 'qwen2.5:3b'),
      });
      stagehandConfig.llmClient = llmClient;
      console.log(chalk.cyan('✓ 已配置Ollama本地LLM客户端'));
    } catch (error: any) {
      console.error(chalk.red('\n✗ Ollama客户端初始化失败:'));
      console.error(chalk.red(error.message));
      console.error(chalk.yellow('\n请确保:'));
      console.error(chalk.yellow('  1. Ollama服务正在运行: ollama serve'));
      console.error(chalk.yellow('  2. 已下载模型: ollama pull qwen2.5:3b'));
      console.error(chalk.yellow('  3. 检查 .env 文件中的 OLLAMA_BASE_URL 和 OLLAMA_MODEL 配置'));
      throw error;
    }
  } else if (hasAnthropic && !hasOpenAI && !hasGoogle) {
    const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    stagehandConfig.model = anthropicModel;
    console.log(chalk.cyan(`使用 Anthropic 模型: ${anthropicModel}（从环境变量读取 API Key）`));
  } else if (hasAnthropic && hasOpenAI) {
    delete process.env.OPENAI_API_KEY;
    const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    stagehandConfig.model = anthropicModel;
    console.log(chalk.cyan(`检测到多个API Key，优先使用 Anthropic 模型: ${anthropicModel}`));
  } else if (hasOpenAI) {
    try {
      const openAIModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      llmClient = new AISdkClient({
        model: OpenaiProvider.languageModel(openAIModel),
      });
      stagehandConfig.llmClient = llmClient;
      console.log(chalk.cyan(`✓ 已配置 OpenAI 模型: ${openAIModel}（使用 openaiProvider，支持代理）`));
    } catch (error: any) {
      console.error(chalk.red('\n✗ OpenAI客户端初始化失败:'));
      console.error(chalk.red(error.message));
      throw error;
    }
  } else if (hasGoogle) {
    if (process.env.GOOGLE_MODEL) {
      stagehandConfig.model = process.env.GOOGLE_MODEL;
      console.log(chalk.cyan(`使用 Google 模型: ${process.env.GOOGLE_MODEL}`));
    } else {
      console.log(chalk.cyan('使用 Google 模型（自动检测）'));
    }
  }

  return { stagehandConfig, llmClient };
}
