/**
 * 记录模式 - 使用 Playwright 打开浏览器，记录用户操作并生成可供 stagehand.act 使用的 ActionJson
 */

import 'dotenv/config';
import { chromium } from '@playwright/test';
import { ActionRecorder, getRecorderInitScript, type RecordedAction } from './actionRecorder.js';
import { NetworkInterceptor, type ApiEndpoint, type NetworkResponse, type NetworkRequest } from '../utils/networkInterceptor.js';
import { parseApiEndpoints } from '../data/excelParser.js';
import { ensureDataFileFromExcel, saveApiRecords, type ActionJson } from '../data/dataStore.js';
import { ensurePlaywrightBrowsersInstalled } from '../utils/browserChecker.js';
import { generateZodSchemaCode } from '../utils/zodSchemaGenerator.js';
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
  /** 输出目录或旧版“输出文件路径”（取目录部分）；记录文件名为 record-时间戳.json */
  outputFile?: string;
  headless?: boolean;
  debug?: boolean;
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
  /** 本次记录的时间戳，用于 record-{ts}.json 与 record-{ts}.zip */
  private recordTimestamp: string = '';

  constructor(options: RecorderOptions = {}) {
    this.options = {
      url: options.url || '',
      excelFile: options.excelFile || '',
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
    console.log('  - 记录将保存到:', join(outDir, `record-${this.recordTimestamp}.json`), '及同名的 .zip trace');
    console.log('');
  }

  /** 记录与 trace 的输出目录 */
  private getRecordsOutDir(): string {
    if (!this.options.outputFile) return resolve(process.cwd(), 'records');
    const p = resolve(process.cwd(), this.options.outputFile);
    return this.options.outputFile.endsWith('.json') ? dirname(p) : p;
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

    const ts = this.recordTimestamp || formatRecordTimestamp();
    const outDir = this.getRecordsOutDir();
    const outputPath = join(outDir, `record-${ts}.json`);
    const tracePath = join(outDir, `record-${ts}.zip`);

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
        const mockConfigPath = join(outDir, `record-${ts}-mock-config.json`);
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
    
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});

    console.log(chalk.green('✓ 记录模式已停止'));
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
