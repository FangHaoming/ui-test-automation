/**
 * 记录模式 - 使用 Playwright 打开浏览器，记录用户操作并生成可供 stagehand.act 使用的 ActionJson
 */

import 'dotenv/config';
import { chromium } from '@playwright/test';
import { Stagehand } from '@browserbasehq/stagehand';
import { ActionRecorder, getRecorderInitScript, type RecordedAction } from './actionRecorder.js';
import { NetworkInterceptor, type ApiEndpoint, type NetworkResponse, type NetworkRequest } from '../utils/networkInterceptor.js';
import { parseApiEndpoints } from '../data/excelParser.js';
import {
  ensureDataFileFromExcel,
  saveApiRecords,
  loadDataFile,
  saveDataFile,
  type ActionJson,
  type ActResultJson,
  type TestResultJson
} from '../data/dataStore.js';
import { ensurePlaywrightBrowsersInstalled } from '../utils/browserChecker.js';
import { generateZodSchemaCode } from '../utils/zodSchemaGenerator.js';
import { checkApiKeys, buildStagehandConfig } from '../executor/llmConfig.js';
import { verifyExpectedResultWithAI, type AssertionPlan } from '../ai/aiAssertionEngine.js';
import { checkResultMatch } from '../executor/resultMatch.js';
import { waitForPageLoadIfUrlChanged } from '../executor/pageLoadWait.js';
import chalk from 'chalk';
import { resolve, dirname, join } from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir } from '../utils/fsUtils.js';

/** 格式化为 record-时间戳 用的字符串，例如 20260210-143022 */
function formatRecordTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${h}${min}${s}`;
}

export interface RecorderOptions {
  url?: string;
  excelFile?: string; // 用于读取API endpoint配置
  /** data JSON 路径（--data 时传入），用于写入 result.steps 与断言；与 excelFile 二选一或同时有 */
  dataPath?: string;
  /** 输出目录（取目录部分）；记录文件名为 record-test-case.json / record-url.json，新覆盖旧 */
  outputFile?: string;
  headless?: boolean;
  debug?: boolean;
  /** 若按用例 ID 启动记录模式，则携带正在录制的用例 ID，便于在 stop 阶段写入 result.steps */
  testCaseId?: string;
}

export class RecorderMode {
  private browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  private context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>> | null = null;
  private page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>> | null = null;
  private actionRecorder: ActionRecorder | null = null;
  private networkInterceptor: NetworkInterceptor | null = null;
  private options: Required<RecorderOptions>;
  private apiEndpoints: ApiEndpoint[] = [];
  private dataPath: string = '';
  private recordTimestamp: string = '';

  constructor(options: RecorderOptions = {}) {
    this.options = {
      url: options.url || '',
      excelFile: options.excelFile || '',
      dataPath: options.dataPath || '',
      outputFile: options.outputFile || './records',
      headless: options.headless !== false,
      debug: options.debug || false,
      ...options
    } as Required<RecorderOptions>;
  }

  /**
   * 初始化记录器（使用 Playwright 打开浏览器，无需 Stagehand/LLM）
   */
  async init(): Promise<void> {
    await ensurePlaywrightBrowsersInstalled();

    console.log(chalk.cyan('正在初始化记录模式（Playwright 浏览器）...'));

    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        channel: undefined,
        args: this.options.debug ? ['--auto-open-devtools-for-tabs'] : []
      });
      this.context = await this.browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 }
      });
      this.page = await this.context.newPage();
      await this.context.addInitScript(getRecorderInitScript());
      this.recordTimestamp = formatRecordTimestamp();
      await this.context.tracing.start({ screenshots: true, snapshots: true });
    } catch (error: any) {
      console.error(chalk.red('\n✗ Playwright 浏览器启动失败:'), error?.message ?? error);
      throw error;
    }

    this.actionRecorder = new ActionRecorder(this.page);
    await this.actionRecorder.startRecording();

    this.networkInterceptor = new NetworkInterceptor(this.page);

    if (this.options.excelFile) {
      // 优先：如果传入了 Excel，则从 Excel 同步 data JSON，并从 Excel 的「API URL」列解析 endpoint
      try {
        const { dataPath } = await ensureDataFileFromExcel(this.options.excelFile);
        this.dataPath = dataPath;
        console.log(chalk.green(`✓ 数据已同步到: ${dataPath}`));
        this.apiEndpoints = await parseApiEndpoints(this.options.excelFile);
        this.networkInterceptor.setEndpoints(this.apiEndpoints);
        console.log(chalk.green(`✓ 已加载 ${this.apiEndpoints.length} 个API endpoint配置`));
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法读取API配置: ${error.message}`));
      }
    } else if (this.options.dataPath) {
      // 仅传入 data JSON 时，从每个 testCase.apiUrls 恢复 endpoint 配置；
      // 若存在旧版 apiUrlMapping，则作为兼容兜底。
      this.dataPath = this.options.dataPath;
      console.log(chalk.green(`✓ 数据文件: ${this.dataPath}`));
      try {
        const data = await loadDataFile(this.dataPath);
        const endpoints: ApiEndpoint[] = [];
        // 仅使用每个用例自身的 apiUrls 字段，不再兼容旧版的 apiUrlMapping
        (data.testCases || []).forEach(tc => {
          if (tc.apiUrls && tc.apiUrls.length > 0) {
            tc.apiUrls.forEach(url => {
              endpoints.push({
                url,
                recordOnly: true,
                testCaseId: tc.id
              });
            });
          }
        });
        if (endpoints.length > 0) {
          this.apiEndpoints = endpoints;
          this.networkInterceptor.setEndpoints(endpoints);
          console.log(chalk.green(`✓ 已从 data JSON 加载 ${endpoints.length} 个API endpoint配置`));
        }
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法从 data JSON 读取 API URL 映射: ${error.message}`));
      }
    }

    await this.networkInterceptor.startIntercepting();

    console.log(chalk.green('✓ 记录模式已启动'));
    console.log(chalk.cyan('\n提示:'));
    console.log('  - 在浏览器中进行操作，将生成可供 stagehand.act / Playwright 回放用的 action');
    if (this.apiEndpoints.length > 0) {
      console.log(`  - 已配置 ${this.apiEndpoints.length} 个API endpoint，将自动捕获其请求和响应`);
      console.log('  - 捕获的真实响应将自动生成mock配置');
    }
    console.log('  - 按 Ctrl+C 停止记录并保存结果');
    const outDir = this.getRecordsOutDir();
    const prefix = this.getRecordFilePrefix();
    console.log('  - 记录将保存到:', join(outDir, `${prefix}.json`), '及同名的 .zip trace');
    console.log('');
  }

  /** 记录与 trace 的输出目录 */
  private getRecordsOutDir(): string {
    if (!this.options.outputFile) return resolve(process.cwd(), 'records');
    const p = resolve(process.cwd(), this.options.outputFile);
    return this.options.outputFile.endsWith('.json') ? dirname(p) : p;
  }

  /** 记录文件名前缀：按用例录制为 record-test-case，按 URL 录制为 record-url */
  private getRecordFilePrefix(): string {
    return this.options.testCaseId ? 'record-test-case' : 'record-url';
  }

  /**
   * 导航到指定URL
   */
  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('记录器未初始化');
    }

    console.log(chalk.cyan(`导航到: ${url}`));
    await this.page.goto(url, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(2000);

    if (this.actionRecorder) {
      console.log(chalk.gray('  [记录器] 页面导航完成，重新设置监听器...'));
      await this.page.waitForTimeout(1000);
      await this.actionRecorder.startRecording();
    }
  }

  /**
   * 开始记录
   */
  async start(): Promise<void> {
    if (!this.page) {
      await this.init();
    }
    
    // 如果提供了URL，导航到该URL
    if (this.options.url) {
      await this.navigate(this.options.url);
    } else {
      console.log(chalk.yellow('未指定URL，请在浏览器中手动导航'));
    }
    
    // 等待用户操作（通过监听事件）
    console.log(chalk.green('\n开始记录用户操作...'));
    console.log(chalk.yellow('按 Ctrl+C 停止记录\n'));
  }

  /**
   * 停止记录并保存结果
   * 注意：先收集数据并写入文件，再做清理，避免 page.evaluate 挂起导致未保存
   */
  async stop(): Promise<void> {
    console.log(chalk.cyan('\n正在停止记录...'));
    
    // 先停止轮询、停止网络拦截，并立即收集数据（不依赖可能挂起的 page.evaluate）
    if (this.actionRecorder) {
      this.actionRecorder.stopRecordingSync();
    }
    if (this.networkInterceptor) {
      this.networkInterceptor.stopIntercepting();
    }
    
    const requests = this.networkInterceptor?.getRecordedRequests() || [];
    const responses = this.networkInterceptor?.getRecordedResponses() || [];
    
    // 根据记录的响应生成mock配置
    const mockConfigs: any[] = [];
    const testCaseResponseMap = new Map<string, Map<string, NetworkResponse>>(); // testCaseId -> (apiUrl -> response)
    const testCaseRequestMap = new Map<string, Map<string, NetworkRequest>>(); // testCaseId -> (apiUrl -> request)
    
    // 为每个配置的endpoint生成mock配置，并按测试用例分组
    this.apiEndpoints.forEach(endpoint => {
      const endpointUrl = typeof endpoint.url === 'string' ? endpoint.url : endpoint.url.toString();
      const testCaseId = endpoint.testCaseId || '';
      const safeEndpointUrl = String(endpointUrl || '');
      
      // 找到匹配的请求和响应（安全地处理可能为 undefined 的 url）
      const matchingResponses = responses.filter(r => {
        const responseUrl = r?.url || '';
        return responseUrl.includes(safeEndpointUrl) || responseUrl === safeEndpointUrl;
      });
      const matchingRequests = requests.filter(r => {
        const requestUrl = r?.url || '';
        return requestUrl.includes(safeEndpointUrl) || requestUrl === safeEndpointUrl;
      });
      
      if (matchingResponses.length > 0) {
        // 使用最后一次响应作为mock数据
        const lastResponse = matchingResponses[matchingResponses.length - 1];
        const matchingRequest = matchingRequests.find(r => r.url === lastResponse.url) || matchingRequests[matchingRequests.length - 1];
        
        mockConfigs.push({
          url: endpointUrl,
          method: matchingRequest?.method || 'GET',
          mockResponse: {
            status: lastResponse.status,
            headers: lastResponse.headers,
            body: lastResponse.body
          }
        });
        
        // 按测试用例分组保存响应和请求
        if (testCaseId) {
          if (!testCaseResponseMap.has(testCaseId)) {
            testCaseResponseMap.set(testCaseId, new Map());
          }
          testCaseResponseMap.get(testCaseId)!.set(endpointUrl, lastResponse);
          
          if (matchingRequest) {
            if (!testCaseRequestMap.has(testCaseId)) {
              testCaseRequestMap.set(testCaseId, new Map());
            }
            testCaseRequestMap.get(testCaseId)!.set(endpointUrl, matchingRequest);
          }
        }
      }
    });
    
    // 如果提供了 Excel 文件，将请求和响应写入 data 目录下对应的 JSON
    if (this.dataPath && (testCaseResponseMap.size > 0 || testCaseRequestMap.size > 0)) {
      try {
        await saveApiRecords(
          this.dataPath,
          testCaseRequestMap,
          testCaseResponseMap,
          (body) => generateZodSchemaCode(body)
        );
        console.log(chalk.green(`✓ API 记录已写入: ${this.dataPath}`));
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法写入 JSON: ${error.message}`));
      }
    }
    
    /** 可供 stagehand.act / executeActionWithPlaywright 回放用的 action 列表 */
    const actionsForAct: ActionJson[] = this.actionRecorder?.getActionsForAct() || [];

    const recordedData = {
      timestamp: new Date().toISOString(),
      url: this.options.url || '',
      /** 供 stagehand.act 回放用的 action 列表（selector, description, method, arguments） */
      actions: actionsForAct,
      actionDescriptions: this.actionRecorder?.getActionDescriptions() || [],
      networkRequests: requests,
      networkResponses: responses,
      apiEndpoints: this.apiEndpoints,
      mockConfigs: mockConfigs
    };

    const outDir = this.getRecordsOutDir();
    const prefix = this.getRecordFilePrefix();
    const outputPath = join(outDir, `${prefix}.json`);
    const tracePath = join(outDir, `${prefix}.zip`);

    const outputPathAbs = resolve(process.cwd(), outputPath);
    const tracePathAbs = resolve(process.cwd(), tracePath);

    try {
      await ensureDir(outDir);

      // 先保存 trace（screenshots 的临时文件在 context 未关闭时才有；Ctrl+C 时浏览器可能已收 SIGINT 并清理临时文件导致 ENOENT）
      if (this.context) {
        const tryStopTrace = async (): Promise<boolean> => {
          try {
            await this.context!.tracing.stop({ path: tracePathAbs });
            return true;
          } catch (_) {
            return false;
          }
        };
        let ok = await tryStopTrace();
        if (!ok) {
          await new Promise(r => setTimeout(r, 400));
          ok = await tryStopTrace();
        }
        if (ok) {
          console.log(chalk.green(`✓ Trace 已保存到: ${tracePath}`));
          console.log(chalk.cyan(`  查看: npx playwright show-trace ${tracePathAbs}`));
        } else {
          console.warn(chalk.yellow('保存 trace 失败（多为 Ctrl+C 导致浏览器先退出）。若需含截图的 trace，请用: touch records/.stop-recording 停止记录'));
        }
      }

      await writeFile(outputPathAbs, JSON.stringify(recordedData, null, 2), 'utf-8');
      console.log(chalk.green(`✓ 记录已保存到: ${outputPath}（actions 可直接给 stagehand.act 回放）`));

      // 生成mock配置文件（如果有关注的API）
      if (mockConfigs.length > 0) {
        const mockConfigPath = join(outDir, `${prefix}-mock-config.json`);
        await writeFile(mockConfigPath, JSON.stringify(mockConfigs, null, 2), 'utf-8');
        console.log(chalk.green(`✓ Mock配置已保存到: ${mockConfigPath}`));
        console.log(chalk.cyan(`  已为 ${mockConfigs.length} 个API endpoint生成mock配置`));
      }
      
      console.log(chalk.cyan('\n记录统计:'));
      console.log(`  操作数（stagehand.act 可用）: ${recordedData.actions.length}`);
      console.log(`  网络请求数: ${recordedData.networkRequests.length}`);
      console.log(`  网络响应数: ${recordedData.networkResponses.length}`);
      if (mockConfigs.length > 0) {
        console.log(`  生成的Mock配置数: ${mockConfigs.length}`);
      }
      
    } catch (error: any) {
      console.error(chalk.red(`保存失败: ${error.message}`));
    }
    
    // 若当前是按用例 ID 启动的记录模式（携带 testCaseId 且已有 dataPath），则在记录结束后：
    // 1. 使用 Stagehand 回放刚才录制的 actions；
    // 2. 基于用例的 expectedResult 做一次断言；
    // 3. 断言通过（或未配置预期结果）时，将录制的 actions 写入 data JSON 中对应用例的 result.steps。
    if (actionsForAct.length > 0 && this.options.testCaseId && this.dataPath) {
      await this.verifyAndPersistRecordedActions(actionsForAct).catch((error: any) => {
        console.warn(
          chalk.yellow(
            `[记录断言] 在基于 expectedResult 做断言或写入 result.steps 时出错: ${error?.message || error}`
          )
        );
      });
    }

    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});

    console.log(chalk.green('✓ 记录模式已停止'));
  }

  /**
   * 使用 Stagehand 回放录制的 actions 并基于 expectedResult 做断言；
   * 只有断言通过时，才将 actions 写入 data JSON 中的 result.steps。
   */
  private async verifyAndPersistRecordedActions(actionsForAct: ActionJson[]): Promise<void> {
    if (!this.options.testCaseId || !this.dataPath) {
      return;
    }

    const testCaseId = this.options.testCaseId;

    const data = await loadDataFile(this.dataPath);
    const idx = data.testCases.findIndex(tc => tc.id === testCaseId);
    if (idx === -1) {
      console.warn(
        chalk.yellow(
          `[记录断言] 在数据文件 ${this.dataPath} 中未找到用例 ${testCaseId}，跳过断言与 result.steps 写入`
        )
      );
      return;
    }

    const testCase = data.testCases[idx];
    const expectedResult = (testCase.expectedResult || '').trim();

    if (!expectedResult) {
      console.log(
        chalk.yellow(
          `[记录断言] 用例 ${testCase.id} 未配置 expectedResult，跳过断言，直接写入录制的 actions 到 result.steps`
        )
      );
      const noWaitInfo = actionsForAct.map(() => ({
        pageLoadWaitAttempted: false,
        pageLoadWaitTimedOut: false
      }));
      await this.writeRecordedStepsToDataFile(
        data,
        idx,
        actionsForAct,
        {
          log: '录制模式：未配置预期结果，未执行断言',
          plan: undefined
        },
        noWaitInfo
      );
      return;
    }

    console.log(
      chalk.cyan(
        `\n[记录断言] 正在为用例 ${testCase.id} 基于 expectedResult 执行一次验证，并在通过后写入 result.steps...`
      )
    );

    checkApiKeys();
    const { stagehandConfig, llmClient } = buildStagehandConfig({
      debug: this.options.debug,
      headless: false
    });

    const stagehand = new Stagehand(stagehandConfig as any);
    try {
      await stagehand.init();
      const page = stagehand.context.pages()[0];

      // 导航到测试 URL（复用与 TestExecutor 类似的 URL 处理逻辑）
      let url = String(testCase.url || '').trim();
      if (!url) {
        throw new Error('测试URL为空，无法在录制后执行断言');
      }
      try {
        new URL(url);
      } catch {
        const urlWithProtocol = url.startsWith('http') ? url : `https://${url}`;
        try {
          new URL(urlWithProtocol);
          url = urlWithProtocol;
        } catch {
          throw new Error(`无效的URL格式: ${url}`);
        }
      }

      console.log(chalk.cyan(`[记录断言] 导航到: ${url}`));
      await page.goto(url);
      console.log(chalk.green('[记录断言] 页面加载完成，开始回放录制的操作...'));

      // 每个 action 回放后单独记录 pageLoadWaitAttempted / pageLoadWaitTimedOut
      const perActionWait: { pageLoadWaitAttempted: boolean; pageLoadWaitTimedOut: boolean }[] = [];

      for (const action of actionsForAct) {
        const urlBeforeAct = page.url();

        // Stagehand 的 act() 不支持某些 Playwright 特有的方法（例如 check/uncheck），
        // 在仅用于“断言回放”的场景下，将这些方法安全地降级为 click，
        // 确保最终页面状态一致，同时不影响真正测试执行时的 Playwright 回放能力。
        const actionForStagehand: ActionJson = { ...action };
        const methodLower = (actionForStagehand.method || '').toLowerCase();
        if (methodLower === 'check' || methodLower === 'uncheck') {
          actionForStagehand.method = 'click';
        }

        const actResult: any = await (stagehand as any).act(actionForStagehand);
        if (actResult && typeof actResult === 'object' && actResult.success === false) {
          const msg = actResult.message || actResult.error || '操作执行失败';
          console.error(chalk.red(`[记录断言] 回放操作失败: ${msg}`));
          throw new Error(`回放操作失败: ${msg}`);
        }

        // 若本次操作触发了 URL 变化，则等待页面加载完成后再继续下一步，
        // 避免因为立即执行下一条而导致元素尚未渲染完成、找不到元素。
        try {
          const waitInfo = await waitForPageLoadIfUrlChanged(
            page as any,
            urlBeforeAct,
            (...args: any[]) => console.log(chalk.gray('[记录断言 wait]'), ...args),
            10000
          );
          perActionWait.push({
            pageLoadWaitAttempted: waitInfo.attempted,
            pageLoadWaitTimedOut: waitInfo.timedOut
          });
        } catch (e: any) {
          perActionWait.push({ pageLoadWaitAttempted: true, pageLoadWaitTimedOut: true });
          console.warn(
            chalk.yellow(
              `[记录断言] 等待页面加载时出错，将继续后续操作: ${e?.message || String(e)}`
            )
          );
        }
      }

      console.log(chalk.cyan('[记录断言] 操作回放完成，开始根据 expectedResult 做 AI 断言...'));
      const { log, plan } = await verifyExpectedResultWithAI({
        expectedResult,
        stagehand,
        page,
        llmClient,
        existingPlan: undefined
      });

      const matched = checkResultMatch(expectedResult, log);
      if (!matched) {
        console.error(
          chalk.red(
            `[记录断言] 预期结果不匹配，将不会把录制的 actions 写入 result.steps。\n  预期: ${expectedResult}\n  实际: ${log}`
          )
        );
        return;
      }

      console.log(
        chalk.green(
          '[记录断言] 预期结果匹配，已将当前录制视为“有效用例”，接下来写入 data JSON 中的 result.steps。'
        )
      );

      await this.writeRecordedStepsToDataFile(
        data,
        idx,
        actionsForAct,
        { log, plan },
        perActionWait
      );
    } finally {
      try {
        await stagehand.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  /**
   * 将录制得到的 actions 按「每个 action 一个 step」写入 result.steps，
   * 每个 step 单独带 pageLoadWaitAttempted / pageLoadWaitTimedOut，并持久化到 data JSON。
   */
  private async writeRecordedStepsToDataFile(
    data: Awaited<ReturnType<typeof loadDataFile>>,
    testCaseIndex: number,
    actionsForAct: ActionJson[],
    assertionResult: { log: string; plan?: AssertionPlan | undefined },
    perActionWait: { pageLoadWaitAttempted: boolean; pageLoadWaitTimedOut: boolean }[]
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const prevResult: TestResultJson | undefined = data.testCases[testCaseIndex].result;

    const steps: ActResultJson[] = actionsForAct.map((action, i) => {
      const wait = perActionWait[i];
      return {
        success: true,
        message: '',
        actionDescription: action.description || '录制操作',
        actions: [action],
        pageLoadWaitAttempted: wait?.pageLoadWaitAttempted ?? false,
        pageLoadWaitTimedOut: wait?.pageLoadWaitTimedOut ?? false
      };
    });

    const newResult: TestResultJson = {
      status: 'passed',
      steps,
      actualResult: assertionResult.log,
      error: null,
      startTime: prevResult?.startTime || nowIso,
      endTime: nowIso,
      duration: prevResult?.duration ?? 0,
      assertionPlan: assertionResult.plan ?? prevResult?.assertionPlan,
      tracePath: prevResult?.tracePath,
      ...(prevResult?.log ? { log: prevResult.log } : {})
    };

    // 将 result.steps 里的 actionDescription 同步到用例的 steps（JSON 的测试步骤文案）
    const stepsTexts = steps.map(s => s.actionDescription);

    data.testCases[testCaseIndex] = {
      ...data.testCases[testCaseIndex],
      steps: stepsTexts,
      result: newResult
    };

    await saveDataFile(this.dataPath, data);
    console.log(
      chalk.green(
        `[记录断言] 已将录制的 ${steps.length} 个操作写入 ${this.dataPath} 中用例 ${data.testCases[testCaseIndex].id} 的 result.steps，并同步到 steps 文案。`
      )
    );
  }

  /**
   * 获取当前记录的操作（供 stagehand.act 使用的 ActionJson 列表）
   */
  getActionsForAct(): ActionJson[] {
    return this.actionRecorder?.getActionsForAct() || [];
  }

  /** @deprecated 使用 getActionsForAct */
  getActions(): RecordedAction[] {
    return this.actionRecorder?.getActions() || [];
  }

  /**
   * 获取操作描述列表
   */
  getActionDescriptions(): string[] {
    return this.actionRecorder?.getActionDescriptions() || [];
  }

  /**
   * 关闭记录器
   */
  async close(): Promise<void> {
    await this.stop();
  }
}
