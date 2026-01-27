import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import type { TestCase } from './excelParser.js';
import { parseApiEndpoints } from './excelParser.js';
import { NetworkInterceptor, type NetworkRequest } from './networkInterceptor.js';
import { ensurePlaywrightBrowsersInstalled } from './browserChecker.js';
import { validateWithZodSchema } from './zodSchemaGenerator.js';
import { createOllamaLLMClient } from './ollamaLLMClient.js';
import { createCustomOpenAIClient } from './customOpenAIClient.js';
import chalk from 'chalk';

/**
 * 测试步骤结果接口
 */
export interface StepResult {
  stepNumber: number;
  description: string;
  status: 'pending' | 'passed' | 'failed';
  error: string | null;
}

/**
 * 测试结果接口
 */
export interface TestResult {
  id: string;
  name: string;
  url: string;
  status: 'pending' | 'passed' | 'failed';
  steps: StepResult[];
  expectedResult: string;
  actualResult: string;
  error: string | null;
  startTime: Date;
  endTime: Date | null;
  duration: number;
}

/**
 * 测试执行器配置选项
 */
export interface TestExecutorOptions {
  headless?: boolean;
  debug?: boolean;
  timeout?: number;
  apiConfigFile?: string; // API配置Excel文件路径
}

/**
 * 测试统计信息接口
 */
export interface TestStatistics {
  total: number;
  passed: number;
  failed: number;
  passRate: string;
  totalDuration: string;
  averageDuration: string;
}

/**
 * 测试执行器类
 */
export class TestExecutor {
  protected stagehand: Stagehand | null = null;
  protected page: any = null;
  protected options: Required<TestExecutorOptions>;
  private results: TestResult[] = [];
  private networkInterceptor: NetworkInterceptor | null = null;

  constructor(options: TestExecutorOptions = {}) {
    this.options = {
      headless: options.headless !== false,
      debug: options.debug || false,
      timeout: options.timeout || 30000,
      apiConfigFile: options.apiConfigFile || '',
      ...options
    } as Required<TestExecutorOptions>;
  }

  /**
   * 检查API密钥配置
   */
  private checkApiKeys(): void {
    const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    
    if (useLocalLLM) {
      const localLLMUrl = process.env.LOCAL_LLM_URL || 'http://localhost:3001';
      const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
      console.log(chalk.cyan('✓ 使用本地LLM模式'));
      console.log(chalk.gray(`   本地LLM服务: ${localLLMUrl}`));
      console.log(chalk.gray(`   Ollama模型: ${ollamaModel}`));
      
      // 设置OpenAI API Key为本地代理地址（Stagehand需要这个）
      // 使用一个虚拟的key，但设置baseURL指向本地服务
      if (!process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = 'local-llm-key';
      }
      
      // 设置OpenAI base URL指向本地代理
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
      const configuredKeys = [];
      if (hasOpenAI) {
        configuredKeys.push('OpenAI');
        // 验证 OpenAI API Key 格式
        const openAiKey = process.env.OPENAI_API_KEY || '';
        if (!openAiKey.startsWith('sk-') && openAiKey !== 'local-llm-key') {
          console.warn(chalk.yellow('⚠️  警告: OPENAI_API_KEY 格式可能不正确（应以 sk- 开头）'));
        }
      }
      if (hasAnthropic) {
        configuredKeys.push('Anthropic');
        // 验证 Anthropic API Key 格式
        const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
        if (!anthropicKey.startsWith('sk-ant-')) {
          console.warn(chalk.yellow('⚠️  警告: ANTHROPIC_API_KEY 格式可能不正确（应以 sk-ant- 开头）'));
        } else {
          // 显示 API Key 的前几个字符用于验证
          const keyPreview = anthropicKey.substring(0, 12) + '...';
          console.log(chalk.gray(`   Anthropic API Key: ${keyPreview}`));
        }
      }
      if (hasGoogle) configuredKeys.push('Google');
      console.log(chalk.green(`✓ 检测到 API Key: ${configuredKeys.join(', ')}`));
    }
  }

  /**
   * 初始化Stagehand
   */
  async init(): Promise<void> {
    // 检查API密钥配置
    this.checkApiKeys();
    
    // 确保 Playwright 浏览器已安装
    await ensurePlaywrightBrowsersInstalled();
    
    console.log('正在初始化Stagehand...');
    
    // 检查是否使用本地LLM
    const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    
    // 确定使用的模型提供商
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    // 构建Stagehand配置
    // 启用详细日志以显示操作过程
    const stagehandConfig: any = {
      env: 'LOCAL',
      verbose: this.options.debug ? 2 : 1, // 即使非debug模式也启用基本日志
      localBrowserLaunchOptions: {
        headless: this.options.headless
      },
    };
    
    // 如果使用本地LLM，使用AI SDK的Ollama集成
    if (useLocalLLM) {
      try {
        const ollamaModel = await createOllamaLLMClient();
        // Stagehand v3 支持通过 llmClient 参数传入自定义LLM客户端
        stagehandConfig.llmClient = ollamaModel;
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
    }
    // Stagehand v3 会自动从环境变量检测 API Key 和模型
    // 模型名称可以从环境变量读取，如果没有设置则使用默认值
    else if (hasAnthropic && !hasOpenAI && !hasGoogle) {
      // 只配置了 Anthropic，从环境变量读取模型名称，如果没有则使用默认值
      const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      stagehandConfig.model = anthropicModel;
      console.log(chalk.cyan(`使用 Anthropic 模型: ${anthropicModel}（从环境变量读取 API Key）`));
    } else if (hasAnthropic && hasOpenAI) {
      // 如果同时配置了多个，优先使用 Anthropic
      // 临时移除 OpenAI 环境变量，确保使用 Anthropic
      const openAiKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      stagehandConfig.model = anthropicModel;
      console.log(chalk.cyan(`检测到多个API Key，优先使用 Anthropic 模型: ${anthropicModel}`));
      // 注意：这里不恢复 OPENAI_API_KEY，因为我们已经选择了 Anthropic
    } else if (hasOpenAI) {
      // 如果只有OpenAI，使用 CustomOpenAIClient（支持代理）
      try {
        const openAIModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
        const openAIClient = createCustomOpenAIClient({
          modelName: openAIModel,
        });
        stagehandConfig.llmClient = openAIClient;
        console.log(chalk.cyan(`✓ 已配置 OpenAI 模型: ${openAIModel}（使用 CustomOpenAIClient，支持代理）`));
        if (process.env.PROXY_URL && process.env.DISABLE_PROXY !== 'true') {
          console.log(chalk.gray(`   代理地址: ${process.env.PROXY_URL}`));
        }
      } catch (error: any) {
        console.error(chalk.red('\n✗ OpenAI客户端初始化失败:'));
        console.error(chalk.red(error.message));
        throw error;
      }
    } else if (hasGoogle) {
      // 如果只有Google，从环境变量读取模型名称（如果设置了）
      if (process.env.GOOGLE_MODEL) {
        stagehandConfig.model = process.env.GOOGLE_MODEL;
        console.log(chalk.cyan(`使用 Google 模型: ${process.env.GOOGLE_MODEL}`));
      } else {
        console.log(chalk.cyan('使用 Google 模型（自动检测）'));
      }
    }
    
    try {
      this.stagehand = new Stagehand(stagehandConfig);
      
      await this.stagehand.init();
      this.page = this.stagehand.context.pages()[0];
    } catch (error: any) {
      // 处理初始化错误，特别是 API 认证错误
      const errorMessage = error?.message || String(error || '未知错误');
      let errorString = '{}';
      try {
        errorString = JSON.stringify(error) || '{}';
      } catch {
        errorString = String(error || '未知错误');
      }
      
      // 确保都是字符串
      const safeErrorMessage = String(errorMessage || '未知错误');
      const safeErrorString = String(errorString || '{}');
      
      if (safeErrorMessage.includes('403') || safeErrorString.includes('forbidden') || safeErrorString.includes('Request not allowed')) {
        console.error(chalk.red('\n✗ API 认证失败 (403 Forbidden)'));
        console.error(chalk.yellow('可能的原因:'));
        console.error(chalk.yellow('  1. API Key 无效或已过期'));
        console.error(chalk.yellow('  2. API Key 没有正确的权限'));
        console.error(chalk.yellow('  3. API Key 格式不正确'));
        console.error(chalk.yellow('  4. 账户可能被限制或暂停'));
        console.error(chalk.yellow('\n请检查:'));
        if (hasAnthropic) {
          const key = process.env.ANTHROPIC_API_KEY || '';
          const keyPreview = key.length > 0 ? key.substring(0, 12) + '...' : '(未设置)';
          console.error(chalk.yellow(`  - ANTHROPIC_API_KEY 是否正确: ${keyPreview}`));
          console.error(chalk.yellow('  - 访问 https://console.anthropic.com/ 验证 API Key 状态'));
        }
        if (hasOpenAI) {
          console.error(chalk.yellow('  - OPENAI_API_KEY 是否正确'));
          console.error(chalk.yellow('  - 访问 https://platform.openai.com/api-keys 验证 API Key 状态'));
        }
        console.error(chalk.yellow('\n详细错误信息:'));
        console.error(chalk.red(safeErrorString));
      } else {
        console.error(chalk.red('\n✗ Stagehand 初始化失败:'));
        console.error(chalk.red(safeErrorMessage));
        if (error.stack) {
          console.error(chalk.gray(error.stack));
        }
      }
      throw error;
    }
    
    // 如果提供了API配置文件，设置网络拦截器
    if (this.options.apiConfigFile) {
      try {
        const endpoints = await parseApiEndpoints(this.options.apiConfigFile);
        if (endpoints.length > 0) {
          this.networkInterceptor = new NetworkInterceptor(this.page);
          this.networkInterceptor.setEndpoints(endpoints);
          await this.networkInterceptor.startIntercepting();
          console.log(chalk.green(`✓ 已加载 ${endpoints.length} 个API endpoint配置，开始拦截网络请求`));
        }
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法加载API配置: ${error.message}`));
      }
    }
    
    console.log('Stagehand初始化完成');
  }

  /**
   * 执行单个测试用例
   * @param testCase - 测试用例对象
   * @returns 测试结果
   */
  async executeTestCase(testCase: TestCase): Promise<TestResult> {
    const result: TestResult = {
      id: testCase.id,
      name: testCase.name,
      url: testCase.url,
      status: 'pending',
      steps: [],
      expectedResult: testCase.expectedResult,
      actualResult: '',
      error: null,
      startTime: new Date(),
      endTime: null,
      duration: 0
    };

    try {
      if (!this.stagehand) {
        throw new Error('Stagehand未初始化');
      }
      
      console.log(`\n开始执行测试用例: ${testCase.name} (${testCase.id})`);
      
      // 导航到测试URL
      if (testCase.url) {
        // 确保URL是有效的字符串
        const url = String(testCase.url).trim();
        if (!url) {
          throw new Error('测试URL为空');
        }
        
        // 验证URL格式
        try {
          new URL(url);
        } catch {
          // 如果不是完整URL，尝试添加协议
          const urlWithProtocol = url.startsWith('http') ? url : `https://${url}`;
          try {
            new URL(urlWithProtocol);
            testCase.url = urlWithProtocol;
          } catch {
            throw new Error(`无效的URL格式: ${url}`);
          }
        }
        
        console.log(`导航到: ${testCase.url}`);
        try {
          // 使用更灵活的等待策略，增加超时时间
          await this.page.goto(testCase.url)
          console.log(chalk.green('✓ 页面加载完成'));
        } catch (navError: any) {
          // 如果 networkidle 失败，尝试使用 domcontentloaded
          if (navError.message?.includes('timeout') || navError.message?.includes('Navigation timeout')) {
            console.warn(chalk.yellow('⚠️  页面加载超时，尝试使用更宽松的等待策略...'));
            try {
              await this.page.goto(testCase.url)
              console.log(chalk.green('✓ 页面加载完成（使用宽松策略）'));
            } catch (retryError: any) {
              console.error(chalk.red(`✗ 页面加载失败: ${retryError.message}`));
              throw new Error(`页面导航失败: ${retryError.message}`);
            }
          } else {
            throw navError;
          }
        }
      }

      // 执行测试步骤
      for (let i = 0; i < testCase.steps.length; i++) {
        const step = testCase.steps[i];
        const stepResult: StepResult = {
          stepNumber: i + 1,
          description: step,
          status: 'pending',
          error: null
        };

        try {
          console.log(`  步骤 ${i + 1}: ${step}`);
          
          // 使用Stagehand的act方法执行自然语言指令
          if (!this.stagehand) {
            throw new Error('Stagehand未初始化');
          }
          
          // 执行操作并记录开始时间
          const actStartTime = Date.now();
          console.log(chalk.blue(`    [开始执行] ${step}`));
          
          // 执行 act 方法，尝试获取返回值
          let actResult: any;
          try {
            // 直接使用原始指令，让 Stagehand 自己理解
            actResult = await this.stagehand.act(step);
            
            // 检查 act 方法的返回值，如果返回失败，抛出错误
            if (actResult) {
              if (Array.isArray(actResult)) {
                console.log(chalk.green(`    [操作详情] 执行了 ${actResult.length} 个操作:`));
                actResult.forEach((action: any, idx: number) => {
                  const actionDesc = action?.description || action?.type || JSON.stringify(action);
                  console.log(chalk.green(`      ${idx + 1}. ${actionDesc}`));
                });
              } else if (typeof actResult === 'object') {
                // 检查是否是失败的结果
                if (actResult.success === false) {
                  const errorMessage = actResult.message || actResult.error || '操作执行失败';
                  const actionDescription = actResult.actionDescription || step;
                  console.error(chalk.red(`    [操作失败] ${errorMessage}`));
                  
                  // 提供更详细的诊断信息
                  if (actResult.actions && actResult.actions.length === 0) {
                    console.error(chalk.yellow(`    [诊断] 无法找到可操作的元素`));
                    console.error(chalk.yellow(`    [建议] 尝试以下方法：`));
                    console.error(chalk.yellow(`      1. 检查页面是否已完全加载`));
                    console.error(chalk.yellow(`      2. 检查元素是否存在或被遮挡`));
                    console.error(chalk.yellow(`      3. 尝试使用更具体的元素描述（如ID、标签文本等）`));
                  }
                  
                  throw new Error(`Stagehand 操作失败: ${errorMessage} (指令: ${actionDescription})`);
                } else {
                  // 成功的情况，打印操作详情
                  console.log(chalk.green(`    [操作详情] ${JSON.stringify(actResult, null, 2).substring(0, 500)}`));
                }
              } else {
                console.log(chalk.green(`    [操作结果] ${String(actResult).substring(0, 200)}`));
              }
            }
          } catch (actError: any) {
            const actDuration = Date.now() - actStartTime;
            console.error(chalk.red(`    [执行失败] 耗时: ${actDuration}ms`));
            console.error(chalk.red(`    [错误信息] ${actError?.message || String(actError)}`));
            throw actError;
          }
          
          const actDuration = Date.now() - actStartTime;
          console.log(chalk.green(`    [执行完成] 耗时: ${actDuration}ms`));
          
          stepResult.status = 'passed';
          await this.page.waitForTimeout(500); // 步骤间等待
        } catch (error: any) {
          stepResult.status = 'failed';
          
          // 详细打印错误信息用于调试
          console.error(chalk.red('\n=== 详细错误信息 ==='));
          console.error(chalk.yellow('错误类型:'), typeof error);
          console.error(chalk.yellow('错误值:'), error);
          console.error(chalk.yellow('error === undefined:'), error === undefined);
          console.error(chalk.yellow('error === null:'), error === null);
          
          if (error) {
            console.error(chalk.yellow('error.constructor:'), error.constructor?.name);
            console.error(chalk.yellow('error.message:'), error.message);
            console.error(chalk.yellow('error.stack:'), error.stack);
            console.error(chalk.yellow('Object.keys(error):'), Object.keys(error || {}));
          }
          
          // 安全地提取错误信息，确保始终是字符串
          let errorMessage = '未知错误';
          try {
            if (error && typeof error === 'object') {
              errorMessage = error.message || error.toString() || '未知错误';
            } else if (error !== undefined && error !== null) {
              errorMessage = String(error);
            }
          } catch (e) {
            errorMessage = '无法提取错误信息';
          }
          
          let errorString = '{}';
          try {
            if (error !== undefined && error !== null) {
              errorString = JSON.stringify(error, null, 2) || '{}';
            }
          } catch (e) {
            try {
              errorString = String(error) || '{}';
            } catch {
              errorString = '无法序列化错误';
            }
          }
          
          console.error(chalk.yellow('提取的 errorMessage:'), errorMessage);
          console.error(chalk.yellow('提取的 errorString:'), errorString);
          console.error(chalk.yellow('errorMessage 类型:'), typeof errorMessage);
          console.error(chalk.yellow('errorString 类型:'), typeof errorString);
          
          // 确保 errorMessage 和 errorString 都是字符串
          const safeErrorMessage = String(errorMessage || '未知错误');
          const safeErrorString = String(errorString || '{}');
          
          console.error(chalk.yellow('safeErrorMessage:'), safeErrorMessage);
          console.error(chalk.yellow('safeErrorString:'), safeErrorString);
          console.error(chalk.red('=== 错误信息结束 ===\n'));
          
          // 检查是否是 API 认证错误
          try {
            if (safeErrorMessage.includes('403') || safeErrorString.includes('forbidden') || safeErrorString.includes('Request not allowed')) {
              const detailedError = `API 认证失败 (403): ${safeErrorString}`;
              stepResult.error = detailedError;
              console.error(chalk.red(`  步骤 ${i + 1} 执行失败: API 认证错误`));
              console.error(chalk.yellow('  请检查 API Key 是否正确配置和有效'));
              console.error(chalk.gray(`  详细错误: ${safeErrorString}`));
            } else {
              stepResult.error = safeErrorMessage;
              console.error(`  步骤 ${i + 1} 执行失败: ${safeErrorMessage}`);
            }
          } catch (e: any) {
            console.error(chalk.red('处理错误信息时发生异常:'), e);
            stepResult.error = `错误处理异常: ${e?.message || String(e)}`;
          }
          
          throw error;
        }

        result.steps.push(stepResult);
      }

      // 验证API请求（如果配置了Zod schema）
      if (testCase.apiRequestSchemas && testCase.apiRequestSchemas.size > 0) {
        console.log(`验证API请求（使用Zod schema）...`);
        const apiValidationResult = await this.validateApiRequests(testCase.id, testCase.apiRequestSchemas);
        
        if (!apiValidationResult.success) {
          result.status = 'failed';
          result.error = `API请求验证失败: ${apiValidationResult.error}`;
          console.log(chalk.red(`✗ API请求验证失败: ${apiValidationResult.error}`));
        } else {
          console.log(chalk.green(`✓ API请求验证通过`));
        }
      }
      
      // 验证预期结果
      if (testCase.expectedResult) {
        console.log(`验证预期结果: ${testCase.expectedResult}`);
        result.actualResult = await this.verifyExpectedResult(testCase.expectedResult);
        
        if (this.checkResultMatch(testCase.expectedResult, result.actualResult)) {
          if (result.status !== 'failed') {
            result.status = 'passed';
          }
          console.log('✓ 测试通过');
        } else {
          result.status = 'failed';
          result.error = `预期结果不匹配。预期: ${testCase.expectedResult}, 实际: ${result.actualResult}`;
          console.log('✗ 测试失败: 预期结果不匹配');
        }
      } else {
        // 如果没有预期结果，只要步骤都执行成功且API验证通过就认为通过
        if (result.status !== 'failed') {
          result.status = 'passed';
          result.actualResult = '所有步骤执行成功';
        }
        console.log('✓ 测试通过（无预期结果验证）');
      }

    } catch (error: any) {
      result.status = 'failed';
      
      // 详细打印错误信息
      console.error(chalk.red('\n=== 测试用例执行失败 - 详细错误信息 ==='));
      console.error(chalk.yellow('错误类型:'), typeof error);
      console.error(chalk.yellow('错误值:'), error);
      
      if (error) {
        console.error(chalk.yellow('error.constructor:'), error.constructor?.name);
        console.error(chalk.yellow('error.message:'), error?.message);
        console.error(chalk.yellow('error.stack:'), error?.stack);
        if (error.stack) {
          console.error(chalk.gray('\n完整堆栈:'));
          console.error(chalk.gray(error.stack));
        }
      }
      
      // 安全地提取错误信息
      let errorMessage = '未知错误';
      try {
        if (error && typeof error === 'object' && 'message' in error) {
          errorMessage = String(error.message) || '未知错误';
        } else if (error !== undefined && error !== null) {
          errorMessage = String(error);
        }
      } catch (e: any) {
        errorMessage = `无法提取错误信息: ${e?.message || String(e)}`;
      }
      
      result.error = errorMessage;
      console.error(chalk.red(`测试用例执行失败: ${errorMessage}`));
      console.error(chalk.red('=== 错误信息结束 ===\n'));
    } finally {
      result.endTime = new Date();
      result.duration = result.endTime.getTime() - result.startTime.getTime();
    }

    this.results.push(result);
    return result;
  }

  /**
   * 验证预期结果
   * @param expectedResult - 预期结果描述
   * @returns 实际结果
   */
  async verifyExpectedResult(expectedResult: string): Promise<string> {
    if (!this.stagehand) {
      throw new Error('Stagehand未初始化');
    }
    
    try {
      // 使用observe方法观察页面状态，然后手动提取信息
      const observations = await this.stagehand.observe(
        `检查页面是否符合以下预期: ${expectedResult}`
      );
      
      // observe返回Action[]，将其转换为描述字符串
      const observationText = observations.map(a => a.description).join('; ') || '无法观察结果';
      
      // 尝试使用简单的extract获取页面文本
      try {
        const pageText = await this.stagehand.extract() as { pageText: string };
        return observationText + (pageText.pageText ? `\n页面内容: ${pageText.pageText.substring(0, 200)}` : '');
      } catch {
        return observationText;
      }
    } catch (error: any) {
      console.warn(`结果验证时出错: ${error.message}`);
      // 如果提取失败，使用observe的结果
      try {
        const observations = await this.stagehand.observe(
          `描述当前页面状态，特别是与以下预期相关的内容: ${expectedResult}`
        );
        // observe返回Action[]，我们需要将其转换为描述字符串
        const observationText = observations.map(a => a.description).join('; ') || '验证失败';
        return observationText;
      } catch (e: any) {
        return '验证失败: ' + e.message;
      }
    }
  }

  /**
   * 验证API请求是否符合Zod schema
   * @param testCaseId - 测试用例ID
   * @param apiRequestSchemas - API URL到Zod schema的映射
   * @returns 验证结果
   */
  async validateApiRequests(
    testCaseId: string,
    apiRequestSchemas: Map<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.networkInterceptor) {
      return { success: true }; // 如果没有拦截器，跳过验证
    }
    
    const recordedRequests = this.networkInterceptor.getRecordedRequests();
    const errors: string[] = [];
    
    // 为每个配置的API验证请求
    for (const [apiUrl, zodSchemaStr] of apiRequestSchemas.entries()) {
      // 找到匹配的请求（安全地处理可能为 undefined 的 url）
      const matchingRequests = recordedRequests.filter(r => {
        const requestUrl = r?.url || '';
        const safeApiUrl = String(apiUrl || '');
        return requestUrl.includes(safeApiUrl) || requestUrl === safeApiUrl;
      });
      
      if (matchingRequests.length === 0) {
        errors.push(`未找到API请求: ${apiUrl}`);
        continue;
      }
      
      // 验证每个匹配的请求
      for (const request of matchingRequests) {
        try {
          // 解析请求体
          let requestBody: any = {};
          if (request.postData) {
            try {
              requestBody = JSON.parse(request.postData);
            } catch {
              requestBody = { raw: request.postData };
            }
          }
          
          // 使用Zod schema验证
          const { z } = await import('zod');
          const validationResult = validateWithZodSchema(zodSchemaStr, requestBody, z);
          
          if (!validationResult.success) {
            errors.push(`API ${apiUrl} 请求验证失败: ${validationResult.error}`);
          }
        } catch (error: any) {
          errors.push(`API ${apiUrl} 请求验证出错: ${error.message}`);
        }
      }
    }
    
    if (errors.length > 0) {
      return {
        success: false,
        error: errors.join('; ')
      };
    }
    
    return { success: true };
  }

  /**
   * 检查结果是否匹配
   * @param expected - 预期结果
   * @param actual - 实际结果
   * @returns 是否匹配
   */
  checkResultMatch(expected: string, actual: string): boolean {
    // 防御性检查：确保参数是字符串
    const safeExpected = String(expected || '');
    const safeActual = String(actual || '');
    
    // 简单的关键词匹配
    const expectedLower = safeExpected.toLowerCase();
    const actualLower = safeActual.toLowerCase();
    
    // 检查是否包含关键的成功指标
    const successKeywords = ['成功', '通过', '显示', '跳转', '出现', '正确', 'success', 'pass', 'show', 'display'];
    const failureKeywords = ['失败', '错误', '失败', 'error', 'fail', 'wrong'];
    
    // 如果实际结果包含失败关键词，返回false
    if (failureKeywords.some(keyword => actualLower.includes(keyword))) {
      return false;
    }
    
    // 如果预期结果包含成功关键词，检查实际结果是否也包含
    if (successKeywords.some(keyword => expectedLower.includes(keyword))) {
      return successKeywords.some(keyword => actualLower.includes(keyword));
    }
    
    // 简单的文本相似度检查（可以改进为更复杂的匹配逻辑）
    return actualLower.includes(expectedLower) || 
           expectedLower.split(' ').some(word => actualLower.includes(word));
  }

  /**
   * 执行所有测试用例
   * @param testCases - 测试用例数组
   * @returns 测试结果数组
   */
  async executeAll(testCases: TestCase[]): Promise<TestResult[]> {
    if (!this.stagehand) {
      await this.init();
    }

    console.log(`\n开始执行 ${testCases.length} 个测试用例...\n`);
    
    for (const testCase of testCases) {
      await this.executeTestCase(testCase);
    }

    return this.results;
  }

  /**
   * 获取 Stagehand 实例（用于扩展功能）
   */
  getStagehand(): Stagehand | null {
    return this.stagehand;
  }

  /**
   * 获取 Page 实例（用于扩展功能）
   */
  getPage(): any {
    return this.page;
  }

  /**
   * 关闭浏览器
   */
  async close(): Promise<void> {
    if (this.networkInterceptor) {
      this.networkInterceptor.stopIntercepting();
    }
    
    if (this.stagehand) {
      await this.stagehand.close();
      console.log('浏览器已关闭');
    }
  }

  /**
   * 获取测试结果统计
   * @returns 统计信息
   */
  getStatistics(): TestStatistics {
    const total = this.results.length;
    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);

    return {
      total,
      passed,
      failed,
      passRate: total > 0 ? ((passed / total) * 100).toFixed(2) + '%' : '0%',
      totalDuration: totalDuration + 'ms',
      averageDuration: total > 0 ? (totalDuration / total).toFixed(2) + 'ms' : '0ms'
    };
  }
}
