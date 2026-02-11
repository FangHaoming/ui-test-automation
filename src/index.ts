import 'dotenv/config';
import { createTemplateWithApiConfig, parseApiEndpoints } from './data/excelParser.js';
import {
  loadTestCasesFromExcelAndSave,
  loadTestCasesFromDataFile,
  mergeExcelToDataFile,
  deleteTestCaseFromDataFile,
  saveTestResults,
  loadDataFile,
  ensureDataFileFromExcel,
  saveApiRecords,
  type ActResultJson,
  type TestResultJson
} from './data/dataStore.js';
import type { AssertionPlan } from './ai/aiAssertionEngine.js';
import { TestExecutor } from './executor/testExecutor.js';
import { ReportGenerator } from './report/reportGenerator.js';
import { RecorderMode } from './recorder/recorderMode.js';
import { generateZodSchemaCode } from './utils/zodSchemaGenerator.js';
import type { NetworkRequest, NetworkResponse, ApiEndpoint } from './utils/networkInterceptor.js';
import { InteractiveMode } from './mode/interactiveMode.js';
import chalk from 'chalk';
import { join, resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { ensureDir } from './utils/fsUtils.js';


/**
 * 命令行选项接口
 */
interface CommandLineOptions {
  excelFile: string | null;
  /** 指定 data 目录下的 JSON 文件作为用例来源（与 --excel 二选一） */
  dataFile: string | null;
  outputDir: string;
  headless: boolean;
  debug: boolean;
  createTemplate: boolean;
  record: boolean;
  recordUrl: string | null;
  recordOutput: string;
  apiConfig: string | null;
  interactive: boolean;
  interactiveUrl: string | null;
  /** 最大并发执行的用例数量（浏览器实例数），<=0 或未设置时表示不限制 */
  maxConcurrency?: number;
  /** 仅执行指定测试用例 ID（--case-id <id>），不指定则执行全部 */
  caseId: string | null;
  /** 记录模式下当前正在录制的用例 ID（内部传递用） */
  recordTestCaseId?: string;
  /** 记录模式使用的 data JSON 路径（--data 时传入，用于写入 result.steps/断言） */
  recordDataPath?: string;
  /** 将 Excel 合并到 JSON（--merge-to-json），已存在同 ID 的用例则跳过 */
  mergeToJson: boolean;
  /** 仅执行 result.status 为 failed 的用例（--only-failed，仅 --data 时有效） */
  onlyFailed: boolean;
  /** 从 JSON 中删除指定测试用例并删除对应 trace（--delete-case <id>，需配合 --data） */
  deleteCase: string | null;
  /** 仅校验 API 请求（忽略 expectedResult 文本断言），用于页面改版但接口不变场景 */
  onlyApi: boolean;
  /** 在执行模式下同时记录 API 请求并写入 data JSON（生成/更新 apiRecords） */
  recordApi: boolean;
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 解析命令行参数
  const options: CommandLineOptions = {
    excelFile: null,
    dataFile: null,
    outputDir: './reports',
    headless: true,
    debug: false,
    createTemplate: false,
    record: false,
    recordUrl: null,
    recordOutput: './records',
    apiConfig: null,
    interactive: false,
    interactiveUrl: null,
    maxConcurrency: undefined,
    caseId: null,
    recordTestCaseId: undefined,
    mergeToJson: false,
    onlyFailed: false,
    deleteCase: null,
    onlyApi: false,
    recordApi: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--excel':
      case '-e':
        options.excelFile = args[++i];
        break;
      case '--data':
      case '-j':
        options.dataFile = args[++i];
        break;
      case '--output':
      case '-o':
        options.outputDir = args[++i];
        break;
      case '--headless':
        options.headless = args[++i] !== 'false';
        break;
      case '--debug':
      case '-d':
        options.debug = true;
        break;
      case '--template':
      case '-t':
        options.createTemplate = true;
        break;
      case '--record':
      case '-r':
        options.record = true;
        // 若下一个参数是 URL（以 http 开头），直接作为 recordUrl，方便写：-r https://...
        const next = args[i + 1];
        if (next && (next.startsWith('http://') || next.startsWith('https://'))) {
          options.recordUrl = args[++i];
        }
        break;
      case '--record-output':
        options.recordOutput = args[++i];
        break;
      case '--case-id':
        options.caseId = args[++i] ?? null;
        break;
      case '--merge-to-json':
        options.mergeToJson = true;
        break;
      case '--only-failed':
        options.onlyFailed = true;
        break;
      case '--delete-case':
        options.deleteCase = args[++i] ?? null;
        break;
      case '--only-api':
        options.onlyApi = true;
        break;
      case '--record-api':
        options.recordApi = true;
        break;
      case '--api-config':
      case '--api':
        options.apiConfig = args[++i];
        break;
      case '--interactive':
      case '-i':
        options.interactive = true;
        break;
      case '--interactive-url':
        options.interactiveUrl = args[++i];
        break;
      case '--max-concurrency':
        {
          const raw = args[++i];
          const parsed = Number(raw);
          if (!Number.isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) {
            options.maxConcurrency = Math.floor(parsed);
          } else {
            console.warn(chalk.yellow(`⚠️  无效的 --max-concurrency 值 "${raw}"，将忽略该参数（使用默认并发）`));
          }
        }
        break;
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        if (!args[i].startsWith('-')) {
          const looksLikeUrl = args[i].startsWith('http://') || args[i].startsWith('https://');
          if (options.record && !options.recordUrl && looksLikeUrl) {
            options.recordUrl = args[i];
          } else if (!options.excelFile && !options.dataFile) {
            options.excelFile = args[i];
          }
        }
    }
  }

  // 如果是从 JSON 删除指定测试用例并删除对应 trace
  if (options.deleteCase && options.dataFile) {
    const dataPath = resolve(process.cwd(), options.dataFile);
    if (!existsSync(dataPath)) {
      console.error(chalk.red(`错误: 文件不存在: ${options.dataFile}`));
      process.exit(1);
    }
    const { deleted } = await deleteTestCaseFromDataFile(options.dataFile, options.deleteCase);
    if (!deleted) {
      console.warn(chalk.yellow(`未在 JSON 中找到用例 ID "${options.deleteCase}"，未做任何修改`));
      return;
    }
    const tracePath = join(process.cwd(), 'traces', `trace-${options.deleteCase}.zip`);
    if (existsSync(tracePath)) {
      try {
        unlinkSync(tracePath);
        console.log(chalk.green(`✓ 已删除 trace: ${tracePath}`));
      } catch (e: any) {
        console.warn(chalk.yellow(`删除 trace 失败: ${e?.message || e}`));
      }
    }
    console.log(chalk.green(`✓ 已从 ${options.dataFile} 中删除用例 ${options.deleteCase}\n`));
    return;
  }

  // 如果是 Excel 合并到 JSON（已存在同 ID 则跳过）
  if (options.mergeToJson && options.excelFile) {
    if (!existsSync(options.excelFile)) {
      console.error(chalk.red(`错误: 文件不存在: ${options.excelFile}`));
      process.exit(1);
    }
    const { mergedCount, skippedCount, dataPath } = await mergeExcelToDataFile(
      options.excelFile,
      options.dataFile ?? undefined
    );
    console.log(chalk.cyan('Excel 合并到 JSON'));
    console.log(chalk.green(`✓ 新增: ${mergedCount}，跳过（已存在同 ID）: ${skippedCount}`));
    console.log(chalk.green(`  输出: ${dataPath}\n`));
    return;
  }

  // 如果只是创建模板
  if (options.createTemplate) {
    const excelDir = join(process.cwd(), 'excel');
    await ensureDir(excelDir);
    const templatePath = join(excelDir, 'test-cases-template.xlsx');
    await createTemplateWithApiConfig(templatePath);
    console.log(chalk.green('\n✓ 模板文件创建成功！'));
    console.log(chalk.cyan('请填写测试用例后使用 --excel 参数运行测试。'));
    console.log(chalk.cyan('模板包含API配置工作表，可用于配置需要mock的API endpoint。\n'));
    return;
  }

  // 如果是交互模式
  if (options.interactive) {
    await runInteractiveMode(options);
    return;
  }

  // 如果是按指定测试用例 ID 启动记录模式（--record --case-id <id>）
  if (options.record && options.caseId && (options.excelFile || options.dataFile)) {
    await runRecordById(options);
    return;
  }

  // 如果是记录模式
  if (options.record) {
    await runRecordMode(options);
    return;
  }

  // 检查用例来源：Excel 或 data 下的 JSON 二选一
  if (!options.excelFile && !options.dataFile) {
    console.error(chalk.red('错误: 请指定 Excel 文件 (--excel) 或 data 下的 JSON 文件 (--data)'));
    console.log(chalk.yellow('\n使用方法:'));
    console.log('  node dist/index.js --excel <Excel路径>');
    console.log('  node dist/index.js --data data/<json文件名>  # 直接使用 data 下的 JSON');
    console.log('  node dist/index.js --template  # 创建模板文件');
    console.log('\n更多选项:');
    console.log('  --output, -o <目录>    指定报告输出目录 (默认: ./reports)');
    console.log('  --headless <true|false> 是否无头模式 (默认: true)');
    console.log('  --debug, -d           启用调试模式');
    console.log('  --help, -h            显示帮助信息\n');
    return;
  }

  let testCases: Awaited<ReturnType<typeof loadTestCasesFromExcelAndSave>>['testCases'];
  let dataPath: string;

  if (options.dataFile) {
    const resolvedData = resolve(process.cwd(), options.dataFile);
    if (!existsSync(resolvedData)) {
      console.error(chalk.red(`错误: 文件不存在: ${options.dataFile}`));
      return;
    }
    const loaded = await loadTestCasesFromDataFile(options.dataFile);
    testCases = loaded.testCases;
    dataPath = loaded.dataPath;
  } else {
    if (!existsSync(options.excelFile!)) {
      console.error(chalk.red(`错误: 文件不存在: ${options.excelFile}`));
      return;
    }
    const loaded = await loadTestCasesFromExcelAndSave(options.excelFile!);
    testCases = loaded.testCases;
    dataPath = loaded.dataPath;
  }

  // 若指定了 --case-id，仅保留该 ID 的用例
  if (options.caseId) {
    const matched = testCases.filter(tc => tc.id === options.caseId);
    if (matched.length === 0) {
      console.error(chalk.red(`错误: 未找到测试用例 ID "${options.caseId}"，请检查用例文件中的用例ID`));
      process.exit(1);
    }
    testCases = matched;
  }

  try {
    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.bold.cyan('UI自动化测试工具 - 基于Stagehand'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log(`\n测试用例来源: ${options.dataFile ?? options.excelFile}`);
    console.log(`输出目录: ${options.outputDir}\n`);

    if (!options.dataFile) {
      console.log('正在解析 Excel 并保存为 JSON...');
    } else {
      console.log('正在从 JSON 加载测试用例...');
    }
    console.log(chalk.green(`✓ 成功加载 ${testCases.length} 个测试用例，数据文件: ${dataPath}\n`));

    if (testCases.length === 0) {
      console.warn(chalk.yellow('警告: 未找到任何测试用例'));
      return;
    }

    // 解析API配置（如果提供了）
    let apiEndpoints: any[] = [];
    if (options.apiConfig) {
      try {
        apiEndpoints = await parseApiEndpoints(options.apiConfig);
        console.log(chalk.green(`✓ 已加载 ${apiEndpoints.length} 个API endpoint配置\n`));
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法读取API配置: ${error.message}\n`));
      }
    }

    // 从每个 testCase.result.steps 汇总历史步骤与断言计划，供回放和断言复用
    const data = await loadDataFile(dataPath);

    // 若未显式提供 apiConfig，但 data JSON 中配置了 apiUrls，则根据 apiUrls 补充 API endpoint 列表
    if (!options.apiConfig) {
      const extraEndpoints: any[] = [];
      (data.testCases || []).forEach(tc => {
        if (Array.isArray((tc as any).apiUrls) && (tc as any).apiUrls.length > 0) {
          (tc as any).apiUrls.forEach((url: string) => {
            extraEndpoints.push({
              url,
              recordOnly: true,
              testCaseId: tc.id
            });
          });
        }
      });
      if (extraEndpoints.length > 0) {
        apiEndpoints.push(...extraEndpoints);
        console.log(chalk.green(`✓ 已从 data JSON 加载 ${extraEndpoints.length} 个API endpoint配置\n`));
      }
    }
    const stepHistory: Record<string, ActResultJson[]> = {};
    const assertionPlans: Record<string, AssertionPlan> = {};

    data.testCases.forEach(tc => {
      const result = tc.result as TestResultJson | undefined;
      if (!result) return;

      // 记录断言计划（若存在），供下次复用
      if (result.assertionPlan) {
        assertionPlans[tc.id] = result.assertionPlan;
      }

      // 记录历史步骤（ActResultJson[]），供下次回放与页面等待策略复用
      const steps = result.steps;
      if (steps?.length) {
        stepHistory[tc.id] = steps as ActResultJson[];
      }
    });

    // 从 JSON 执行时：无 expectedResult 的跳过；同时无 steps 且 result.steps 为空的也跳过；--only-failed 时仅保留 result.status 为 failed 的用例
    if (options.dataFile) {
      const beforeCount = testCases.length;
      const dataById = new Map(data.testCases.map(c => [c.id, c]));
      testCases = testCases.filter(tc => {
        const fromData = dataById.get(tc.id);
        if (options.onlyFailed) {
          if (fromData?.result?.status !== 'failed') return false;
        }
        const hasExpected = !!(tc.expectedResult && String(tc.expectedResult).trim().length > 0);
        const hasSteps = !!(tc.steps && tc.steps.length > 0);
        const hasResultSteps = !!(fromData?.result?.steps && fromData.result.steps.length > 0);
        const apiRecords = (fromData as any)?.apiRecords as
          | Record<string, { requestSchema?: string }>
          | undefined;
        const hasApiSchemas =
          !!apiRecords &&
          Object.values(apiRecords).some(
            rec => rec && typeof rec.requestSchema === 'string' && rec.requestSchema.trim().length > 0
          );

        if (options.onlyApi) {
          // 仅校验 API 时：
          // - 不再强制要求 expectedResult
          // - 至少需要“有可回放步骤”或“有可校验的 API schema”，否则跳过
          if (!hasSteps && !hasResultSteps && !hasApiSchemas) return false;
          return true;
        }

        if (!hasExpected) return false;
        return hasSteps || hasResultSteps;
      });
      const skipped = beforeCount - testCases.length;
      if (skipped > 0) {
        console.log(chalk.yellow(`  已跳过 ${skipped} 个${options.onlyFailed ? '（仅执行 failed）' : ''}无预期结果或同时无步骤且无录制步骤的用例\n`));
      }
      if (options.onlyFailed && testCases.length > 0) {
        console.log(chalk.cyan(`  仅执行 result.status 为 failed 的用例，共 ${testCases.length} 个\n`));
      }
    }

    if (testCases.length === 0) {
      console.warn(chalk.yellow('警告: 无可用测试用例（全部被跳过或未找到）'));
      return;
    }

    // 并发执行测试用例：为每个用例创建独立的 TestExecutor / 浏览器实例
    // 支持通过 --max-concurrency 控制最大并发数；未设置或 <=0 时默认 5
    // 若开启 --record-api，则为避免 data JSON 写入冲突，强制串行执行
    const rawMaxConcurrency =
      options.recordApi
        ? 1
        : (typeof options.maxConcurrency === 'number' && options.maxConcurrency > 0
            ? options.maxConcurrency
            : 5);
    const maxConcurrency = Math.min(rawMaxConcurrency, testCases.length);

    const allResults: typeof TestExecutor.prototype['executeAll'] extends (
      ...args: any[]
    ) => Promise<infer R>
      ? R
      : any = [];

    for (let i = 0; i < testCases.length; i += maxConcurrency) {
      const batch = testCases.slice(i, i + maxConcurrency);
      const batchResultsArrays = await Promise.all(
        batch.map(async testCase => {
        // 为当前用例筛选对应的 API endpoint（用于网络记录与 schema 生成）
        const endpointsForCase: ApiEndpoint[] =
          Array.isArray(apiEndpoints) && apiEndpoints.length > 0
            ? apiEndpoints.filter((ep: any) => !ep.testCaseId || ep.testCaseId === testCase.id)
            : [];

          const executor = new TestExecutor({
            headless: options.headless,
            debug: options.debug,
            apiConfigFile: options.apiConfig || undefined,
            apiEndpoints: endpointsForCase,
            recordApi: options.recordApi,
            onlyApi: options.onlyApi
          });
          try {
            const singleResults = await executor.executeAll(
              [testCase],
              {
                stepHistory: stepHistory[testCase.id]
                  ? { [testCase.id]: stepHistory[testCase.id] }
                  : {},
                assertionPlans: assertionPlans[testCase.id]
                  ? { [testCase.id]: assertionPlans[testCase.id] }
                  : {}
              }
            );
            // 若开启 --record-api，则在每个用例执行完后，基于网络记录写入 data JSON 的 apiRecords
            if (options.recordApi && endpointsForCase.length > 0) {
              const snapshot = executor.getNetworkSnapshot();
              if (snapshot && (snapshot.requests.length > 0 || snapshot.responses.length > 0)) {
                const testCaseRequestMap = new Map<string, Map<string, NetworkRequest>>();
                const testCaseResponseMap = new Map<string, Map<string, NetworkResponse>>();

                const reqMapForCase = new Map<string, NetworkRequest>();
                const resMapForCase = new Map<string, NetworkResponse>();

                endpointsForCase.forEach(ep => {
                  const endpointUrl = typeof ep.url === 'string' ? ep.url : ep.url.toString();
                  const safeEndpointUrl = String(endpointUrl || '');

                  const matchingResponses = snapshot.responses.filter(r => {
                    const responseUrl = r?.url || '';
                    return responseUrl.includes(safeEndpointUrl) || responseUrl === safeEndpointUrl;
                  });
                  const matchingRequests = snapshot.requests.filter(r => {
                    const requestUrl = r?.url || '';
                    return requestUrl.includes(safeEndpointUrl) || requestUrl === safeEndpointUrl;
                  });

                  if (matchingResponses.length > 0) {
                    const lastResponse = matchingResponses[matchingResponses.length - 1];
                    const matchingRequest =
                      matchingRequests.find(r => r.url === lastResponse.url) ||
                      matchingRequests[matchingRequests.length - 1];

                    resMapForCase.set(endpointUrl, lastResponse);
                    if (matchingRequest) {
                      reqMapForCase.set(endpointUrl, matchingRequest);
                    }
                  }
                });

                if (reqMapForCase.size > 0) {
                  testCaseRequestMap.set(testCase.id, reqMapForCase);
                }
                if (resMapForCase.size > 0) {
                  testCaseResponseMap.set(testCase.id, resMapForCase);
                }

                if (testCaseRequestMap.size > 0 || testCaseResponseMap.size > 0) {
                  await saveApiRecords(
                    dataPath,
                    testCaseRequestMap,
                    testCaseResponseMap,
                    body => generateZodSchemaCode(body)
                  );
                  console.log(
                    chalk.green(
                      `✓ 已在执行模式下记录用例 ${testCase.id} 的 API 请求/响应并写入到 ${dataPath}`
                    )
                  );
                }
              }
            }
            // 关闭对应浏览器实例
            await executor.close();
            return singleResults;
          } catch (e) {
            // 出错时也尽量关闭浏览器
            await executor.close();
            throw e;
          }
        })
      );
      allResults.push(...batchResultsArrays.flat());
    }

    const results = allResults;

    // 计算整体统计信息（等价于 TestExecutor.getStatistics）
    const total = results.length;
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    const statistics = {
      total,
      passed,
      failed,
      passRate: total > 0 ? ((passed / total) * 100).toFixed(2) + '%' : '0%',
      totalDuration: totalDuration + 'ms',
      averageDuration: total > 0 ? (totalDuration / total).toFixed(2) + 'ms' : '0ms'
    };

    // 将测试结果写入 data 目录下对应的 JSON
    console.log('\n正在写入测试结果到 JSON...');
    await saveTestResults(dataPath, results, statistics);
    console.log(chalk.green(`✓ 测试结果已写入: ${dataPath}`));

    // 生成报告（仅控制台）
    console.log('\n正在生成测试报告...');
    ReportGenerator.printConsoleReport(results, statistics);

    console.log(chalk.green('\n✓ 测试执行完成！\n'));

  } catch (error: any) {
    console.error(chalk.red('\n✗ 执行失败:'), error);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * 运行交互式测试模式
 */
async function runInteractiveMode(options: CommandLineOptions): Promise<void> {
  try {
    const interactiveMode = new InteractiveMode({
      headless: options.headless,
      debug: options.debug,
      apiConfigFile: options.apiConfig || undefined,
      initialUrl: options.interactiveUrl || undefined
    });

    // 处理Ctrl+C信号
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n收到停止信号，正在关闭...'));
      await interactiveMode.close();
      process.exit(0);
    });

    await interactiveMode.start(options.interactiveUrl || undefined);

  } catch (error: any) {
    console.error(chalk.red('\n✗ 交互模式执行失败:'), error);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * 运行记录模式
 */
async function runRecordMode(options: CommandLineOptions): Promise<void> {
  try {
    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.bold.cyan('操作记录模式'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log('');

    // 开始记录前确保 records 目录存在，并删掉上次可能遗留的 .stop-recording
    const recordsDir = join(process.cwd(), 'records');
    await ensureDir(recordsDir);
    const stopFile = resolve(recordsDir, '.stop-recording');
    if (existsSync(stopFile)) {
      try {
        unlinkSync(stopFile);
      } catch {
        // 忽略删除失败
      }
    }

    // 记录模式需要可见浏览器供用户操作，默认不使用无头模式
    const recorder = new RecorderMode({
      url: options.recordUrl || undefined,
      // 优先使用 --excel 作为 API URL 来源；若未指定，则退回到旧的 --api-config（兼容老用法）
      excelFile: options.excelFile || options.apiConfig || undefined,
      dataPath: options.recordDataPath,
      outputFile: options.recordOutput,
      headless: false,
      debug: options.debug,
      testCaseId: options.recordTestCaseId
    });

    // 处理 Ctrl+C：先保存再退出，避免异步未完成就退出
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\n收到停止信号，正在保存记录...'));
      recorder
        .stop()
        .then(() => process.exit(0))
        .catch((err: any) => {
          console.error(chalk.red('保存时出错:'), err?.message || err);
          process.exit(1);
        });
    });

    await recorder.start();

    console.log(chalk.yellow('记录模式运行中，按 Ctrl+C 停止'));
    console.log(chalk.cyan('  若需完整 trace（含截图），请用另一终端执行: touch records/.stop-recording'));
    console.log('');

    await new Promise<void>((_, reject) => {
      const t = setInterval(async () => {
        if (!existsSync(stopFile)) return;
        clearInterval(t);
        try {
          if (existsSync(stopFile)) unlinkSync(stopFile);
        } catch { }
        console.log(chalk.yellow('\n检测到 records/.stop-recording，正在保存记录...'));
        try {
          await recorder.stop();
          process.exit(0);
        } catch (err: any) {
          reject(err);
        }
      }, 2000);
    });

  } catch (error: any) {
    console.error(chalk.red('\n✗ 记录模式执行失败:'), error);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * 根据指定测试用例 ID 启动记录模式
 * 需配合 --excel 或 --data 使用，从用例文件中查找对应 ID 的用例并启动录制。
 */
async function runRecordById(options: CommandLineOptions): Promise<void> {
  try {
    if (!options.caseId) {
      console.error(chalk.red('错误: 录制指定用例时需指定 --case-id <用例ID>，例如 --record --case-id TC-001'));
      process.exit(1);
    }
    if (!options.excelFile && !options.dataFile) {
      console.error(chalk.red('错误: 使用 --record --case-id 时必须指定 --excel <测试用例文件> 或 --data <JSON文件>'));
      process.exit(1);
    }

    let testCases: Awaited<ReturnType<typeof loadTestCasesFromExcelAndSave>>['testCases'];
    let dataPath: string;
    const excelPath = options.excelFile;

    if (options.dataFile) {
      const resolvedData = resolve(process.cwd(), options.dataFile);
      if (!existsSync(resolvedData)) {
        console.error(chalk.red(`错误: 文件不存在: ${options.dataFile}`));
        process.exit(1);
      }
      const loaded = await loadTestCasesFromDataFile(options.dataFile);
      testCases = loaded.testCases;
      dataPath = loaded.dataPath;
    } else {
      if (!existsSync(options.excelFile!)) {
        console.error(chalk.red(`错误: 文件不存在: ${options.excelFile}`));
        process.exit(1);
      }
      console.log(chalk.cyan('正在加载测试用例...'));
      const loaded = await loadTestCasesFromExcelAndSave(options.excelFile!);
      testCases = loaded.testCases;
      dataPath = loaded.dataPath;
      console.log(chalk.green(`✓ 已同步到 ${dataPath}\n`));
    }

    const target = testCases.find(tc => tc.id === options.caseId);
    if (!target) {
      console.error(chalk.red(`错误: 未找到测试用例 ID "${options.caseId}"，请检查用例文件中的用例ID`));
      process.exit(1);
    }

    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.bold.cyan('按指定用例 ID 启动操作记录模式'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log('');
    console.log(chalk.cyan(`将为用例 ${target.id} - ${target.name} 启动浏览器:`));
    console.log('  URL:', target.url);
    console.log('');

    const recordOptions: CommandLineOptions = {
      ...options,
      record: true,
      recordUrl: target.url,
      recordTestCaseId: target.id,
      recordDataPath: dataPath,
      // 录制指定用例时，默认用 --excel 对应的测试用例文件里的 API URL 列作为配置，无需单独传 --api-config
      apiConfig: options.apiConfig
    };

    await runRecordMode(recordOptions);
  } catch (error: any) {
    console.error(chalk.red('\n✗ 记录模式（按用例ID）执行失败:'), error);
    console.error(error.stack);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold.cyan('UI自动化测试工具 - 使用说明')}

${chalk.bold('基本用法:')}
  node dist/index.js --excel <测试用例文件>
  node dist/index.js --data data/<json文件>   # 直接使用 data 下的 JSON，不读 Excel
  node dist/index.js --template  # 创建Excel模板
  node dist/index.js --record <URL>  # 启动操作记录模式
  node dist/index.js --excel <测试用例文件> --record --case-id <用例ID>  # 按指定测试用例ID启动记录模式
  node dist/index.js --data data/<json> --record --case-id <用例ID>  # 从 JSON 指定用例录制
  node dist/index.js --excel <Excel> --merge-to-json [--data <JSON>]  # Excel 合并到 JSON，同 ID 已存在则跳过
  node dist/index.js --interactive  # 启动交互式测试模式

${chalk.bold('命令行选项:')}
  --excel, -e <文件>        Excel测试用例文件路径 (与 --data 二选一)
  --data, -j <文件>         data 目录下的 JSON 文件路径 (与 --excel 二选一)
  --output, -o <目录>       报告输出目录 (默认: ./reports)
  --headless <true|false>   是否无头模式 (默认: true)
  --debug, -d              启用调试模式
  --max-concurrency <数值>  最大并发用例数/浏览器实例数 (默认: 5)
  --case-id <用例ID>        仅执行指定测试用例ID（不指定则执行全部）
  --template, -t            创建Excel模板文件
  --record, -r <URL>        启动操作记录模式，URL 为可选初始地址
  --record-output <目录>    记录模式：输出目录，生成 record-test-case.json/record-url.json 及同名 .zip（新覆盖旧，默认: ./records）
  --record --case-id <ID>   按指定测试用例ID启动记录模式（需配合 --excel 或 --data）
  --interactive, -i         启动交互式测试模式
  --interactive-url <URL>   交互模式：初始URL（可选）
  --api-config <文件>       API配置Excel文件（用于mock，测试和记录模式都支持）
  --merge-to-json          将 Excel 解析结果合并到 JSON，JSON 中已存在同 ID 的用例则跳过；可配合 --data 指定目标 JSON
  --only-failed             仅执行 result.status 为 failed 的用例（仅 --data 时有效）
  --delete-case <用例ID>    从 JSON 中删除指定用例并删除 traces/trace-<id>.zip（需配合 --data）
  --record-api              执行模式：在运行测试的同时记录 API 请求并写入 data JSON（生成/更新 apiRecords）
  --help, -h                显示此帮助信息

${chalk.bold('Excel文件格式:')}
  列1: 用例ID
  列2: 用例名称
  列3: 测试URL
  列4: 测试步骤 (多行，每行一个步骤)
  列5: 预期结果
  列6: 备注
  列7: API配置 (可选，JSON格式)

${chalk.bold('API配置格式:')}
  可以在Excel的"API配置"工作表中配置，或使用JSON格式：
  {"url": "/api/login", "method": "POST", "mockResponse": {"status": 200, "body": {...}}}

${chalk.bold('示例:')}
  # 创建模板
  node dist/index.js --template

  # 运行测试（从 Excel）
  node dist/index.js --excel test-cases.xlsx

  # 运行测试（从 data 下的 JSON）
  node dist/index.js --data data/test-cases-template.json

  # 仅运行指定用例ID
  node dist/index.js --excel test-cases.xlsx --case-id TC-001
  node dist/index.js --data data/test-cases-template.json --case-id TC-001

  # Excel 合并到 JSON（同 ID 已存在则跳过）
  node dist/index.js --excel test-cases.xlsx --merge-to-json
  node dist/index.js --excel test-cases.xlsx --data data/test-cases.json --merge-to-json

  # 从 JSON 删除指定用例及对应 trace
  node dist/index.js --data data/test-cases-template.json --delete-case TC-004

  # 启动记录模式（手动操作浏览器，自动记录）
  node dist/index.js --record https://example.com

  # 启动记录模式并配置API mock
  node dist/index.js --record https://example.com --api-config api-config.xlsx

  # 启动交互式测试模式
  node dist/index.js --interactive

  # 启动交互式测试模式并打开指定URL
  node dist/index.js --interactive --interactive-url https://example.com

  # 启用调试模式
  node dist/index.js --excel test-cases.xlsx --debug
`);
}

// 运行主函数
main().catch(error => {
  console.error(chalk.red('致命错误:'), error);
  process.exit(1);
});
