/**
 * 测试执行器 - 主入口，编排步骤执行、断言与资源管理
 */

import 'dotenv/config';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { chromium, type BrowserContext } from '@playwright/test';
import { Stagehand } from '@browserbasehq/stagehand';
import type { TestCase } from '../data/excelParser.js';
import { parseApiEndpoints } from '../data/excelParser.js';
import { NetworkInterceptor, type ApiEndpoint, type NetworkRequest, type NetworkResponse } from '../utils/networkInterceptor.js';
import { ensurePlaywrightBrowsersInstalled } from '../utils/browserChecker.js';
import { verifyExpectedResultWithAI } from '../ai/aiAssertionEngine.js';
import chalk from 'chalk';

import type {
  StepResult,
  TestResult,
  TestExecutorOptions,
  TestStatistics,
  AssertionPlan,
  ActResultJson,
  ActionJson
} from './types.js';
import { checkApiKeys, buildStagehandConfig } from './llmConfig.js';
import { executeActionWithPlaywright, normalizeActResult } from './playwrightActions.js';
import { waitForPageLoadIfUrlChanged } from './pageLoadWait.js';
import { validateApiRequests } from './apiValidation.js';
import { checkResultMatch } from './resultMatch.js';

// 对外统一从本文件导出类型，便于 index/report/data/mode 继续从 testExecutor 引用
export type {
  StepResult,
  TestResult,
  TestExecutorOptions,
  TestStatistics,
  AssertionPlan,
  ActResultJson,
  ActionJson
} from './types.js';

export class TestExecutor {
  protected stagehand: Stagehand | null = null;
  protected page: any = null;
  protected options: Required<TestExecutorOptions>;
  private results: TestResult[] = [];
  private networkInterceptor: NetworkInterceptor | null = null;
  private llmClient: import('../ai/aisdkClient.js').AISdkClient | null = null;
  private pwBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  private pwContext: BrowserContext | null = null;

  private caseLogPrefix = '';
  private caseLogBuffer: string[] = [];

  constructor(options: TestExecutorOptions = {}) {
    this.options = {
      headless: options.headless !== false,
      debug: options.debug || false,
      timeout: options.timeout || 5000,
      apiConfigFile: options.apiConfigFile || '',
      recordTrace: options.recordTrace !== false,
      traceDir: options.traceDir || './traces',
      ...options
    } as Required<TestExecutorOptions>;
  }

  private static stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private log(...args: any[]): void {
    if (this.caseLogPrefix) {
      const line = [this.caseLogPrefix, ...args].map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      this.caseLogBuffer.push(TestExecutor.stripAnsi(line));
      console.log(this.caseLogPrefix, ...args);
    } else {
      console.log(...args);
    }
  }

  private logWarn(...args: any[]): void {
    if (this.caseLogPrefix) {
      const line = [this.caseLogPrefix, ...args].map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      this.caseLogBuffer.push(TestExecutor.stripAnsi(line));
      console.warn(this.caseLogPrefix, ...args);
    } else {
      console.warn(...args);
    }
  }

  private logError(...args: any[]): void {
    if (this.caseLogPrefix) {
      const line = [this.caseLogPrefix, ...args].map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      this.caseLogBuffer.push(TestExecutor.stripAnsi(line));
      console.error(this.caseLogPrefix, ...args);
    } else {
      console.error(...args);
    }
  }

  async init(): Promise<void> {
    checkApiKeys();
    await ensurePlaywrightBrowsersInstalled();

    console.log('正在初始化Stagehand...');

    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    const { stagehandConfig, llmClient } = buildStagehandConfig({
      headless: this.options.headless,
      debug: this.options.debug
    });
    this.llmClient = llmClient;

    try {
      this.stagehand = new Stagehand(stagehandConfig as any);
      await this.stagehand.init();
      this.page = this.stagehand.context.pages()[0];

      if (this.options.recordTrace) {
        try {
          this.pwBrowser = await chromium.connectOverCDP(this.stagehand.connectURL());
          const contexts = this.pwBrowser.contexts();
          this.pwContext = contexts.length > 0 ? contexts[0] : null;
          if (!this.pwContext) {
            console.warn(chalk.yellow('   [Trace] 无法获取 Playwright context，Trace 记录将禁用'));
          }
        } catch (e: any) {
          console.warn(chalk.yellow(`   [Trace] Playwright CDP 连接失败: ${e?.message || e}，Trace 记录将禁用`));
        }
      }
    } catch (error: any) {
      const errorMessage = error?.message || String(error || '未知错误');
      let errorString = '{}';
      try {
        errorString = JSON.stringify(error) || '{}';
      } catch {
        errorString = String(error || '未知错误');
      }
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
        if (error.stack) console.error(chalk.gray(error.stack));
      }
      throw error;
    }

    // 初始化网络拦截：优先使用外部直接传入的 apiEndpoints，其次尝试从 apiConfigFile 解析
    let endpoints: ApiEndpoint[] = [];
    if (this.options.apiEndpoints && this.options.apiEndpoints.length > 0) {
      endpoints = this.options.apiEndpoints;
    } else if (this.options.apiConfigFile) {
      try {
        endpoints = await parseApiEndpoints(this.options.apiConfigFile);
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法加载API配置: ${error.message}`));
      }
    }
    if (endpoints.length > 0) {
      // 对于执行模式，优先使用 Playwright Page 来做网络监听；若获取不到，则退回 Stagehand 的 page
      const targetPage = this.getPwPage() ?? this.page;
      this.networkInterceptor = new NetworkInterceptor(targetPage);
      this.networkInterceptor.setEndpoints(endpoints);
      await this.networkInterceptor.startIntercepting();
      console.log(chalk.green(`✓ 已加载 ${endpoints.length} 个API endpoint配置，开始拦截网络请求`));
    }

    console.log('Stagehand初始化完成');
  }

  private getPwPage(): import('playwright').Page | null {
    if (!this.pwContext) return null;
    const pages = this.pwContext.pages();
    return pages.length > 0 ? pages[0] : null;
  }

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

    let tracePath: string | undefined;
    this.caseLogPrefix = `[${testCase.id}]`;
    this.caseLogBuffer = [];

    try {
      if (!this.stagehand) throw new Error('Stagehand未初始化');

      if (this.options.recordTrace && this.pwContext) {
        const traceDir = this.options.traceDir || './traces';
        mkdirSync(traceDir, { recursive: true });
        tracePath = join(traceDir, `trace-${testCase.id}.zip`);
        await this.pwContext.tracing.start({ screenshots: true, snapshots: true });
        this.log(chalk.gray(`   [Trace] 已开始记录: ${tracePath}`));
      }

      this.log(`\n开始执行测试用例: ${testCase.name} (${testCase.id})`);

      if (testCase.url) {
        const url = String(testCase.url).trim();
        if (!url) throw new Error('测试URL为空');
        try {
          new URL(url);
        } catch {
          const urlWithProtocol = url.startsWith('http') ? url : `https://${url}`;
          try {
            new URL(urlWithProtocol);
            testCase.url = urlWithProtocol;
          } catch {
            throw new Error(`无效的URL格式: ${url}`);
          }
        }
        this.log(`导航到: ${testCase.url}`);
        const navPage = this.getPwPage() ?? this.page;
        try {
          await navPage.goto(testCase.url);
          this.log(chalk.green('✓ 页面加载完成'));
        } catch (navError: any) {
          if (navError.message?.includes('timeout') || navError.message?.includes('Navigation timeout')) {
            this.logWarn(chalk.yellow('⚠️  页面加载超时，尝试使用更宽松的等待策略...'));
            try {
              await navPage.goto(testCase.url);
              this.log(chalk.green('✓ 页面加载完成（使用宽松策略）'));
            } catch (retryError: any) {
              this.logError(chalk.red(`✗ 页面加载失败: ${retryError.message}`));
              throw new Error(`页面导航失败: ${retryError.message}`);
            }
          } else throw navError;
        }
      }

      // 有 result.steps（录制步骤）时，仅按录制步骤回放，不再用 steps 文案重新执行
      const stepCount =
        (historicalSteps && historicalSteps.length > 0)
          ? historicalSteps.length
          : (testCase.steps.length > 0 ? testCase.steps.length : 0);

      for (let i = 0; i < stepCount; i++) {
        const step =
          (historicalSteps?.[i] as any)?.actionDescription ??
          testCase.steps[i] ??
          `录制步骤 ${i + 1}`;
        const stepResult: StepResult = {
          stepNumber: i + 1,
          description: step,
          status: 'pending',
          error: null
        };
        let stepWaitAttempted = false;
        let stepWaitTimedOut = false;

        try {
          this.log(`  步骤 ${i + 1}: ${step}`);
          if (!this.stagehand) throw new Error('Stagehand未初始化');

          const actStartTime = Date.now();
          const urlBeforeAct = this.page?.url() ?? '';
          const stepHistory = historicalSteps?.[i];
          const hasRecordedActions = stepHistory?.actions?.length;

          if (hasRecordedActions) {
            const pwPage = this.getPwPage();
            if (pwPage) {
              this.log(chalk.blue(`    [回放] 使用 Playwright 执行历史记录的 ${stepHistory.actions.length} 个操作`));
              for (const action of stepHistory.actions) {
                await executeActionWithPlaywright(pwPage, action);
              }
            } else {
              this.log(chalk.blue(`    [回放] 使用历史记录的 ${stepHistory.actions.length} 个操作`));
              for (const action of stepHistory.actions) {
                const actResult = await this.stagehand.act(action);
                if (actResult && typeof actResult === 'object' && actResult.success === false) {
                  const msg = (actResult as { message?: string; error?: string }).error ?? actResult.message;
                  throw new Error(msg || '回放操作失败');
                }
              }
            }
            stepResult.actResult = stepHistory;
          } else {
            this.log(chalk.blue(`    [开始执行] ${step}`));
            const pwPage = this.getPwPage();
            let actResult: any;

            if (pwPage) {
              const observeInstruction = /^(find|查找|定位|get)./i.test(step.trim()) ? step : `find the element to ${step}`;
              const observedActions = await this.stagehand.observe(observeInstruction);
              if (observedActions.length > 0) {
                this.log(chalk.blue(`    [Observe] 找到 ${observedActions.length} 个操作，使用 Playwright 执行`));
                for (const a of observedActions) {
                  const actionJson: ActionJson = {
                    selector: a.selector ?? '',
                    description: a.description ?? '',
                    method: a.method ?? 'click',
                    arguments: Array.isArray(a.arguments) ? a.arguments : []
                  };
                  await executeActionWithPlaywright(pwPage, actionJson);
                }
                actResult = {
                  success: true,
                  message: '',
                  actionDescription: step,
                  actions: observedActions.map((a: any) => ({
                    selector: a.selector ?? '',
                    description: a.description ?? '',
                    method: a.method ?? 'click',
                    arguments: Array.isArray(a.arguments) ? a.arguments : []
                  }))
                };
              } else {
                actResult = await this.stagehand.act(step);
              }
            } else {
              actResult = await this.stagehand.act(step);
            }

            if (actResult) {
              if (Array.isArray(actResult)) {
                this.log(chalk.green(`    [操作详情] 执行了 ${actResult.length} 个操作:`));
                actResult.forEach((action: any, idx: number) => {
                  this.log(chalk.green(`      ${idx + 1}. ${action?.description || action?.type || JSON.stringify(action)}`));
                });
              } else if (typeof actResult === 'object') {
                if (actResult.success === false) {
                  const errorMessage = actResult.message || actResult.error || '操作执行失败';
                  this.logError(chalk.red(`    [操作失败] ${errorMessage}`));
                  if (actResult.actions && actResult.actions.length === 0) {
                    this.logError(chalk.yellow(`    [诊断] 无法找到可操作的元素`));
                  }
                  throw new Error(`Stagehand 操作失败: ${errorMessage} (指令: ${step})`);
                }
                this.log(chalk.green(`    [操作详情] ${JSON.stringify(actResult, null, 2).substring(0, 500)}`));
              } else {
                this.log(chalk.green(`    [操作结果] ${String(actResult).substring(0, 200)}`));
              }
            }
            const normalized = normalizeActResult(actResult, step);
            if (normalized) stepResult.actResult = normalized;
          }

          this.log(chalk.green(`    [执行完成] 耗时: ${Date.now() - actStartTime}ms`));

          const skipWaitForThisStep = !!stepHistory && (stepHistory as any).pageLoadWaitTimedOut === true;
          if (!skipWaitForThisStep) {
            const waitInfo = await waitForPageLoadIfUrlChanged(
              this.getPwPage() ?? this.page,
              urlBeforeAct,
              this.log.bind(this),
              3000
            );
            stepWaitAttempted = waitInfo.attempted;
            stepWaitTimedOut = waitInfo.timedOut;
          }

          stepResult.pageLoadWaitAttempted = stepWaitAttempted;
          stepResult.pageLoadWaitTimedOut = stepWaitTimedOut;
          stepResult.status = 'passed';
        } catch (error: any) {
          stepResult.status = 'failed';
          this.logError(chalk.red('\n=== 详细错误信息 ==='));
          this.logError(chalk.yellow('错误类型:'), typeof error);
          this.logError(chalk.yellow('错误值:'), error);
          if (error) {
            this.logError(chalk.yellow('error.message:'), error.message);
            this.logError(chalk.yellow('error.stack:'), error.stack);
          }
          let errorMessage = '未知错误';
          try {
            if (error && typeof error === 'object') {
              errorMessage = error.message || error.toString() || '未知错误';
            } else if (error != null) errorMessage = String(error);
          } catch {
            errorMessage = '无法提取错误信息';
          }
          let errorString = '{}';
          try {
            errorString = error != null ? JSON.stringify(error, null, 2) || '{}' : '{}';
          } catch {
            errorString = String(error ?? '{}');
          }
          const safeErrorMessage = String(errorMessage || '未知错误');
          const safeErrorString = String(errorString || '{}');
          this.logError(chalk.red('=== 错误信息结束 ===\n'));

          if (safeErrorMessage.includes('403') || safeErrorString.includes('forbidden') || safeErrorString.includes('Request not allowed')) {
            stepResult.error = `API 认证失败 (403): ${safeErrorString}`;
            this.logError(chalk.red(`  步骤 ${i + 1} 执行失败: API 认证错误`));
            this.logError(chalk.yellow('  请检查 API Key 是否正确配置和有效'));
          } else {
            stepResult.error = safeErrorMessage;
            this.logError(`  步骤 ${i + 1} 执行失败: ${safeErrorMessage}`);
          }
          throw error;
        }

        result.steps.push(stepResult);
      }

      let apiValidationSummary: string | null = null;
      let apiValidationFailed = false;

      if (this.options.onlyApi) {
        // 仅在 onlyApi 模式下收集并校验 API 请求，并据此决定用例结果
        // 规则：
        // - 若 testCase.validateApiUrls 未配置或为空，则不做任何 API 校验（视为“未配置 API 校验”）
        // - 否则，仅对 validateApiUrls 中列出的 URL 做校验
        const apiSchemas: Map<string, string> | null = (() => {
          const apiRecords = (testCase as any).apiRecords as
            | Record<string, { requestSchema?: string }>
            | undefined;
          const validateApiUrls = (testCase as any).validateApiUrls as string[] | undefined;

          if (!Array.isArray(validateApiUrls) || validateApiUrls.length === 0) {
            return null;
          }
          if (!apiRecords) return null;

          const map = new Map<string, string>();
          for (const url of validateApiUrls) {
            const rec = apiRecords[url];
            if (rec && typeof rec.requestSchema === 'string' && rec.requestSchema.trim()) {
              map.set(url, rec.requestSchema);
            }
          }
          return map.size > 0 ? map : null;
        })();

        if (apiSchemas && apiSchemas.size > 0) {
          const apiUrls = Array.from(apiSchemas.keys());
          this.log(`验证API请求（使用Zod schema）...`);
          this.log(`本次将校验的 API 列表: ${apiUrls.join(', ')}`);

          const apiValidationResult = await validateApiRequests(
            this.networkInterceptor,
            testCase.id,
            apiSchemas
          );
          if (!apiValidationResult.success) {
            result.status = 'failed';
            result.error = `API请求验证失败: ${apiValidationResult.error}`;
            apiValidationFailed = true;
            apiValidationSummary = `API请求验证失败: ${apiValidationResult.error}。已尝试校验: ${apiUrls.join(
              ', '
            )}`;
            this.log(chalk.red(`✗ API请求验证失败: ${apiValidationResult.error}`));
          } else {
            apiValidationSummary = `API请求验证通过。已校验: ${apiUrls.join(', ')}`;
            this.log(chalk.green(`✓ API请求验证通过`));
          }
        } else {
          apiValidationSummary = null;
        }

        // 仅进行 API 校验：不再执行 expectedResult 的页面断言
        if (apiValidationSummary) {
          result.actualResult = apiValidationSummary;
        } else if (!apiSchemas || apiSchemas.size === 0) {
          result.actualResult = '未配置 API 请求 schema，未执行 API 校验';
        }

        if (!apiValidationFailed && result.status !== 'failed') {
          result.status = 'passed';
          this.log('✓ 测试通过（仅API验证）');
        } else if (apiValidationFailed) {
          this.log('✗ 测试失败（仅API验证）');
        }
      } else {
        if (testCase.expectedResult) {
          this.log(`验证预期结果: ${testCase.expectedResult}`);
          const existingPlan = (testCase as any).result?.assertionPlan || (result as any).assertionPlan;
          const { log, plan } = await this.verifyExpectedResult(testCase.expectedResult, existingPlan || undefined);
          result.actualResult = log;
          if (checkResultMatch(testCase.expectedResult, result.actualResult)) {
            if (result.status !== 'failed') result.status = 'passed';
            if (plan) result.assertionPlan = plan;
            this.log('✓ 测试通过');
          } else {
            result.status = 'failed';
            result.error = `预期结果不匹配。预期: ${testCase.expectedResult}, 实际: ${result.actualResult}`;
            this.log('✗ 测试失败: 预期结果不匹配');
          }
        } else {
          if (result.status !== 'failed') {
            result.status = 'passed';
            result.actualResult = '所有步骤执行成功';
          }
          this.log('✓ 测试通过（无预期结果验证）');
        }
      }
    } catch (error: any) {
      result.status = 'failed';
      this.logError(chalk.red('\n=== 测试用例执行失败 - 详细错误信息 ==='));
      this.logError(chalk.yellow('错误类型:'), typeof error);
      this.logError(chalk.yellow('错误值:'), error);
      if (error) {
        this.logError(chalk.yellow('error.message:'), error?.message);
        this.logError(chalk.yellow('error.stack:'), error?.stack);
      }
      let errorMessage = '未知错误';
      try {
        if (error && typeof error === 'object' && 'message' in error) {
          errorMessage = String(error.message) || '未知错误';
        } else if (error != null) errorMessage = String(error);
      } catch (e: any) {
        errorMessage = `无法提取错误信息: ${e?.message || String(e)}`;
      }
      result.error = errorMessage;
      this.logError(chalk.red(`测试用例执行失败: ${errorMessage}`));
      this.logError(chalk.red('=== 错误信息结束 ===\n'));
    } finally {
      result.endTime = new Date();
      result.duration = result.endTime.getTime() - result.startTime.getTime();
      if (this.options.recordTrace && this.pwContext && tracePath) {
        try {
          const pwPageForTrace = this.getPwPage();
          if (pwPageForTrace) {
            try { await pwPageForTrace.waitForTimeout(3000); } catch (_e) {}
          }
          await this.pwContext.tracing.stop({ path: tracePath });
          result.tracePath = tracePath;
          this.log(chalk.gray(`   [Trace] 已保存: ${tracePath}`));
          this.log(chalk.gray(`   查看: npx playwright show-trace ${tracePath}`));
        } catch (e: any) {
          this.logWarn(chalk.yellow(`   [Trace] 保存失败: ${e?.message || e}`));
        }
      }
      if (result.status === 'failed' && this.caseLogBuffer.length > 0) {
        result.log = this.caseLogBuffer.join('\n');
      }
      this.caseLogPrefix = '';
      this.caseLogBuffer = [];
    }

    this.results.push(result);
    return result;
  }

  async verifyExpectedResult(
    expectedResult: string,
    existingPlan?: AssertionPlan
  ): Promise<{ log: string; plan: AssertionPlan | null }> {
    if (!this.stagehand) throw new Error('Stagehand未初始化');
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
      this.logWarn(`AI 断言流程失败，回退到简单观察模式: ${msg}`);
      try {
        const observations = await this.stagehand.observe(
          `检查页面是否符合以下预期: ${expectedResult}`
        );
        const observationText = observations.map(a => a.description).join('; ') || '验证失败';
        return { log: `AI 断言失败: ${msg}\n回退观察结果: ${observationText}`, plan: null };
      } catch (e: any) {
        return { log: '验证失败: ' + (e?.message || String(e)), plan: null };
      }
    }
  }

  async executeAll(
    testCases: TestCase[],
    options?: {
      stepHistory?: Record<string, ActResultJson[]>;
      assertionPlans?: Record<string, AssertionPlan>;
    }
  ): Promise<TestResult[]> {
    if (!this.stagehand) await this.init();
    const stepHistory = options?.stepHistory;
    const assertionPlans = options?.assertionPlans;
    const withHistory = testCases.filter(tc => stepHistory?.[tc.id]?.length).length;
    if (testCases.length === 1) this.caseLogPrefix = `[${testCases[0].id}]`;
    if (withHistory > 0) {
      this.log(chalk.cyan(`\n${withHistory} 个用例将使用历史操作回放（不调 LLM）\n`));
    }
    this.log(`\n开始执行 ${testCases.length} 个测试用例...\n`);

    for (const testCase of testCases) {
      const historicalSteps = stepHistory?.[testCase.id];
      const existingPlan = assertionPlans?.[testCase.id];
      const testCaseWithPlan: TestCase & { result?: { assertionPlan?: AssertionPlan } } = {
        ...(testCase as any),
        result: existingPlan ? { assertionPlan: existingPlan } : (testCase as any).result
      };
      await this.executeTestCase(testCaseWithPlan, historicalSteps);
    }
    return this.results;
  }

  getStagehand(): Stagehand | null {
    return this.stagehand;
  }

  getPage(): any {
    return this.page;
  }

  /**
   * 获取当前执行过程中的网络请求/响应快照（仅当已启用 NetworkInterceptor 时有效）
   */
  getNetworkSnapshot(): { requests: NetworkRequest[]; responses: NetworkResponse[] } | null {
    if (!this.networkInterceptor) return null;
    return {
      requests: this.networkInterceptor.getRecordedRequests(),
      responses: this.networkInterceptor.getRecordedResponses()
    };
  }

  async close(): Promise<void> {
    if (this.networkInterceptor) this.networkInterceptor.stopIntercepting();
    if (this.pwBrowser) {
      try { await this.pwBrowser.close(); } catch (_e) {}
      this.pwBrowser = null;
      this.pwContext = null;
    }
    if (this.stagehand) {
      await this.stagehand.close();
      console.log('浏览器已关闭');
    }
  }

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
