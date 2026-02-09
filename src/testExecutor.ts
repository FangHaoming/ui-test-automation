import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import type { TestCase } from './excelParser';
import { parseApiEndpoints } from './excelParser';
import { NetworkInterceptor } from './networkInterceptor';
import { ensurePlaywrightBrowsersInstalled } from './browserChecker';
import { validateWithZodSchema } from './zodSchemaGenerator';
import { AISdkClient } from './aisdkClient';
import chalk from 'chalk';
import { OpenaiProvider } from './client-provider/openai-provider';
import { OllamaProvider } from './client-provider/ollama-provider';
import { verifyExpectedResultWithAI, type AssertionPlan } from './aiAssertionEngine';
import type { ActResultJson } from './dataStore.js';

/**
 * 测试步骤结果接口
 */
export interface StepResult {
  stepNumber: number;
  description: string;
  status: 'pending' | 'passed' | 'failed';
  error: string | null;
  /** 步骤通过时 stagehand.act 的返回值，用于后续直接复用（不调 LLM） */
  actResult?: ActResultJson;
  /** 本步操作后是否尝试等待页面加载 */
  pageLoadWaitAttempted?: boolean;
  /** 本步操作等待页面加载是否发生超时 */
  pageLoadWaitTimedOut?: boolean;
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
  /** 若为 true，表示该用例在历史执行中所有 waitForLoadState 均超时，下次执行时可跳过页面加载等待 */
  skipPageLoadWait?: boolean;
  /** 断言计划（由 AI 生成），用于下次复用，避免重复走 LLM 规划 */
  assertionPlan?: AssertionPlan;
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
  // 可选的 AI SDK 客户端，用于生成 Playwright 断言计划
  private llmClient: AISdkClient | null = null;

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
      // 不等待 iframe 加载完成，避免被验证码等第三方 iframe 卡住超时
      domSettleTimeout: 0,
    };
    
    // 如果使用本地LLM，使用AI SDK的Ollama集成
    if (useLocalLLM) {
      try {
        // Stagehand v3 支持通过 llmClient 参数传入自定义LLM客户端
        this.llmClient = new AISdkClient({
          model: OllamaProvider.languageModel(process.env.OLLAMA_MODEL || 'qwen2.5:3b'),
        });
        stagehandConfig.llmClient = this.llmClient;
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
        this.llmClient = new AISdkClient({
          model: OpenaiProvider.languageModel(openAIModel),
        });
        stagehandConfig.llmClient = this.llmClient;
        console.log(chalk.cyan(`✓ 已配置 OpenAI 模型: ${openAIModel}（使用 openaiProvider，支持代理）`));
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
   * act 后若检测到页面 URL 发生变化，则等待页面加载完成后再继续下一步。
   * 返回本次是否尝试等待以及是否发生超时，用于统计是否应在后续跳过等待。
   */
  private async waitForPageLoadIfUrlChanged(
    urlBeforeAct: string
  ): Promise<{ attempted: boolean; timedOut: boolean }> {
    if (!this.page) {
      console.log(chalk.gray(`    [调试] waitForPageLoadIfUrlChanged: page 为空，跳过`));
      return { attempted: false, timedOut: false };
    }
    console.log(chalk.gray(`    [调试] act 前 URL: ${urlBeforeAct}`));
    // 先等待页面加载完成，再判断 URL 是否变化
    let attempted = false;
    let timedOut = false;
    try {
      console.log(chalk.gray(`    [调试] 等待页面加载完成...`));
      attempted = true;
      await this.page.waitForLoadState('networkidle');
    } catch (_e) {
      console.log(chalk.yellow(`    [等待加载] 等待 networkidle 超时，继续执行`));
      timedOut = true;
    }
    const urlAfterLoad = this.page.url();
    console.log(chalk.gray(`    [调试] 加载完成后的 URL: ${urlAfterLoad}`));
    if (urlAfterLoad === urlBeforeAct) {
      console.log(chalk.gray(`    [调试] URL 未变化，不等待`));
      return { attempted, timedOut };
    }
    console.log(chalk.green(`    [已等待] 页面 URL 已变化，加载完成`));
    await this.page.waitForTimeout(500);
    return { attempted, timedOut };
  }

  /**
   * 将 stagehand.act 返回值规范为 ActResultJson（便于存储与回放）
   */
  private normalizeActResult(raw: any, stepDescription: string): ActResultJson | undefined {
    if (!raw) return undefined;
    let actions: ActResultJson['actions'] = [];
    if (Array.isArray(raw)) {
      actions = raw.map((a: any) => ({
        selector: a?.selector ?? '',
        description: a?.description ?? '',
        method: a?.method ?? '',
        arguments: Array.isArray(a?.arguments) ? a.arguments : []
      }));
    } else if (typeof raw === 'object' && Array.isArray(raw.actions)) {
      actions = raw.actions.map((a: any) => ({
        selector: a?.selector ?? '',
        description: a?.description ?? '',
        method: a?.method ?? '',
        arguments: Array.isArray(a?.arguments) ? a.arguments : []
      }));
    }
    if (actions.length === 0) return undefined;
    return {
      success: raw?.success !== false,
      message: raw?.message ?? '',
      actionDescription: raw?.actionDescription ?? stepDescription,
      actions
    };
  }

  /**
   * 执行单个测试用例
   * @param testCase - 测试用例对象
   * @param historicalSteps - 该用例历史执行中记录的每步 act 结果，有则直接回放（不调 LLM）
   * @returns 测试结果
   */
  async executeTestCase(
    testCase: TestCase,
    historicalSteps?: ActResultJson[]
  ): Promise<TestResult> {
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

    // 统计本用例中 waitForLoadState 的尝试与超时次数
    let waitAttempts = 0;
    let waitTimeouts = 0;

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

        // 记录本步是否进行了页面加载等待，以及是否超时
        let stepWaitAttempted = false;
        let stepWaitTimedOut = false;

        try {
          console.log(`  步骤 ${i + 1}: ${step}`);
          
          if (!this.stagehand) {
            throw new Error('Stagehand未初始化');
          }
          
          const actStartTime = Date.now();
          const urlBeforeAct = this.page?.url() ?? '';
          const stepHistory = historicalSteps?.[i];
          const hasRecordedActions = stepHistory?.actions?.length;
          
          if (hasRecordedActions) {
            // 直接复用历史记录的 actions，不调 LLM
            console.log(chalk.blue(`    [回放] 使用历史记录的 ${stepHistory.actions.length} 个操作`));
            for (const action of stepHistory.actions) {
              const actResult = await this.stagehand.act(action);
              if (actResult && typeof actResult === 'object' && actResult.success === false) {
                const msg = (actResult as { message?: string; error?: string }).error ?? actResult.message;
                throw new Error(msg || '回放操作失败');
              }
            }
            // 回放模式下直接复用历史 actResult
            stepResult.actResult = stepHistory;
          } else {
            // 使用自然语言指令，由 Stagehand/LLM 理解
            console.log(chalk.blue(`    [开始执行] ${step}`));
            let actResult: any;
            actResult = await this.stagehand.act(step);
            
            if (actResult) {
              if (Array.isArray(actResult)) {
                console.log(chalk.green(`    [操作详情] 执行了 ${actResult.length} 个操作:`));
                actResult.forEach((action: any, idx: number) => {
                  const actionDesc = action?.description || action?.type || JSON.stringify(action);
                  console.log(chalk.green(`      ${idx + 1}. ${actionDesc}`));
                });
              } else if (typeof actResult === 'object') {
                if (actResult.success === false) {
                  const errorMessage = actResult.message || actResult.error || '操作执行失败';
                  const actionDescription = actResult.actionDescription || step;
                  console.error(chalk.red(`    [操作失败] ${errorMessage}`));
                  if (actResult.actions && actResult.actions.length === 0) {
                    console.error(chalk.yellow(`    [诊断] 无法找到可操作的元素`));
                  }
                  throw new Error(`Stagehand 操作失败: ${errorMessage} (指令: ${actionDescription})`);
                }
                console.log(chalk.green(`    [操作详情] ${JSON.stringify(actResult, null, 2).substring(0, 500)}`));
              } else {
                console.log(chalk.green(`    [操作结果] ${String(actResult).substring(0, 200)}`));
              }
            }
            // 记录本步 act 返回值，供后续执行复用
            const normalized = this.normalizeActResult(actResult, step);
            if (normalized) stepResult.actResult = normalized;
          }
          
          const actDuration = Date.now() - actStartTime;
          console.log(chalk.green(`    [执行完成] 耗时: ${actDuration}ms`));
          
          // 根据「当前步骤」的历史记录决定是否等待页面加载：
          // 若历史中该步骤的页面等待曾超时（pageLoadWaitTimedOut === true），
          // 则本次该步骤直接跳过等待；否则正常等待。
          const skipWaitForThisStep =
            !!stepHistory && (stepHistory as any).pageLoadWaitTimedOut === true;

          if (!skipWaitForThisStep) {
            const waitInfo = await this.waitForPageLoadIfUrlChanged(urlBeforeAct);
            stepWaitAttempted = waitInfo.attempted;
            stepWaitTimedOut = waitInfo.timedOut;
            if (waitInfo.attempted) {
              waitAttempts++;
              if (waitInfo.timedOut) waitTimeouts++;
            }
          } else {
            // 按步骤级别的历史记录跳过本次等待
            stepWaitAttempted = false;
            stepWaitTimedOut = false;
          }

          // 将本步的页面加载等待信息写入步骤结果
          stepResult.pageLoadWaitAttempted = stepWaitAttempted;
          stepResult.pageLoadWaitTimedOut = stepWaitTimedOut;
          
          stepResult.status = 'passed';
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

        // 若历史结果中已存在断言计划，则复用计划，避免重复调用 LLM
        const existingPlan =
          (testCase as any).result?.assertionPlan || (result as any).assertionPlan;

        const { log, plan } = await this.verifyExpectedResult(
          testCase.expectedResult,
          existingPlan || undefined
        );
        result.actualResult = log;
        
        if (this.checkResultMatch(testCase.expectedResult, result.actualResult)) {
          if (result.status !== 'failed') {
            result.status = 'passed';
          }
          // 断言通过时记录断言计划到 result，供下次复用
          if (plan) {
            result.assertionPlan = plan;
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

      // 保留原有字段以兼容历史数据（但不再用于控制行为）
      if (waitAttempts > 0 && waitAttempts === waitTimeouts) {
        result.skipPageLoadWait = true;
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
   * @param existingPlan - 复用的断言计划（可选）
   * @returns { log, plan } - 实际结果日志 + 使用的断言计划
   */
  async verifyExpectedResult(
    expectedResult: string,
    existingPlan?: AssertionPlan
  ): Promise<{ log: string; plan: AssertionPlan | null }> {
    if (!this.stagehand) {
      throw new Error('Stagehand未初始化');
    }
    
    try {
      const { log, plan } = await verifyExpectedResultWithAI({
        expectedResult,
        stagehand: this.stagehand,
        page: this.page,
        llmClient: this.llmClient,
        existingPlan
      });
      return { log, plan };
    } catch (error: any) {
      const msg = error?.message || String(error);
      // 如果 AI 断言流程自身失败，退回到简单的 Stagehand.observe 方案，避免整条用例直接崩溃
      console.warn(`AI 断言流程失败，回退到简单观察模式: ${msg}`);
      try {
        const observations = await this.stagehand.observe(
          `检查页面是否符合以下预期: ${expectedResult}`
        );
        const observationText = observations.map(a => a.description).join('; ') || '验证失败';
        const log = `AI 断言失败: ${msg}\n回退观察结果: ${observationText}`;
        return { log, plan: null };
      } catch (e: any) {
        const log = '验证失败: ' + (e?.message || String(e));
        return { log, plan: null };
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
   * @param options - stepHistory 为 data 中已记录的每步 act 结果，有则直接回放
   * @returns 测试结果数组
   */
  async executeAll(
    testCases: TestCase[],
    options?: {
      stepHistory?: Record<string, ActResultJson[]>;
      /** 每个用例复用的断言计划（来自历史结果） */
      assertionPlans?: Record<string, AssertionPlan>;
    }
  ): Promise<TestResult[]> {
    if (!this.stagehand) {
      await this.init();
    }

    const stepHistory = options?.stepHistory;
    const assertionPlans = options?.assertionPlans;
    const withHistory = testCases.filter(tc => stepHistory?.[tc.id]?.length).length;
    if (withHistory > 0) {
      console.log(chalk.cyan(`\n${withHistory} 个用例将使用历史操作回放（不调 LLM）\n`));
    }
    console.log(`\n开始执行 ${testCases.length} 个测试用例...\n`);
    
    for (const testCase of testCases) {
      const historicalSteps = stepHistory?.[testCase.id];
      const existingPlan = assertionPlans?.[testCase.id];
      // 将 existingPlan 暂存到 testCase 上，供 executeTestCase 内部读取并传给 verifyExpectedResult
      const testCaseWithPlan: TestCase & { result?: { assertionPlan?: AssertionPlan } } = {
        ...(testCase as any),
        result: existingPlan ? { assertionPlan: existingPlan } : (testCase as any).result
      };
      await this.executeTestCase(testCaseWithPlan, historicalSteps);
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
