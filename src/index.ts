import 'dotenv/config';
import { createTemplateWithApiConfig, parseApiEndpoints } from './data/excelParser.js';
import {
  loadTestCasesFromExcelAndSave,
  saveTestResults,
  loadDataFile,
  ensureDataFileFromExcel,
  type ActResultJson,
  type TestResultJson
} from './data/dataStore.js';
import type { AssertionPlan } from './ai/aiAssertionEngine.js';
import { TestExecutor } from './executor/testExecutor.js';
import { ReportGenerator } from './report/reportGenerator.js';
import { RecorderMode } from './recorder/recorderMode.js';
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
  outputDir: string;
  headless: boolean;
  debug: boolean;
  createTemplate: boolean;
  record: boolean;
  recordFromExcel: boolean;
  recordUrl: string | null;
  recordOutput: string;
  apiConfig: string | null;
  interactive: boolean;
  interactiveUrl: string | null;
  /** 最大并发执行的用例数量（浏览器实例数），<=0 或未设置时表示不限制 */
  maxConcurrency?: number;
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  // 解析命令行参数
  const options: CommandLineOptions = {
    excelFile: null,
    outputDir: './reports',
    headless: true,
    debug: false,
    createTemplate: false,
    record: false,
    recordFromExcel: false,
    recordUrl: null,
    recordOutput: './records',
    apiConfig: null,
    interactive: false,
    interactiveUrl: null,
    maxConcurrency: undefined
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--excel':
      case '-e':
        options.excelFile = args[++i];
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
      case '--record-from-excel':
        options.recordFromExcel = true;
        break;
      case '--record-output':
        options.recordOutput = args[++i];
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
        if (!options.excelFile && !args[i].startsWith('-')) {
          options.excelFile = args[i];
        }
    }
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

  // 如果是从 Excel 启动记录模式
  if (options.recordFromExcel) {
    await runRecordFromExcel(options);
    return;
  }

  // 如果是记录模式
  if (options.record) {
    await runRecordMode(options);
    return;
  }

  // 检查Excel文件
  if (!options.excelFile) {
    console.error(chalk.red('错误: 请指定Excel测试用例文件'));
    console.log(chalk.yellow('\n使用方法:'));
    console.log('  node dist/index.js --excel <文件路径>');
    console.log('  node dist/index.js --template  # 创建模板文件');
    console.log('\n更多选项:');
    console.log('  --output, -o <目录>    指定报告输出目录 (默认: ./reports)');
    console.log('  --headless <true|false> 是否无头模式 (默认: true)');
    console.log('  --debug, -d           启用调试模式');
    console.log('  --help, -h            显示帮助信息\n');
    return;
  }

  if (!existsSync(options.excelFile)) {
    console.error(chalk.red(`错误: 文件不存在: ${options.excelFile}`));
    return;
  }

  try {
    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.bold.cyan('UI自动化测试工具 - 基于Stagehand'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log(`\n测试用例文件: ${options.excelFile}`);
    console.log(`输出目录: ${options.outputDir}\n`);

    // 解析 Excel 并保存为 data 目录下的 JSON
    console.log('正在解析 Excel 并保存为 JSON...');
    const { testCases, dataPath } = await loadTestCasesFromExcelAndSave(options.excelFile);
    console.log(chalk.green(`✓ 成功解析 ${testCases.length} 个测试用例，已保存到 ${dataPath}\n`));

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

    // 并发执行测试用例：为每个用例创建独立的 TestExecutor / 浏览器实例
    // 支持通过 --max-concurrency 控制最大并发数；未设置或 <=0 时默认 5
    const rawMaxConcurrency =
      typeof options.maxConcurrency === 'number' && options.maxConcurrency > 0
        ? options.maxConcurrency
        : 5;
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
          const executor = new TestExecutor({
            headless: options.headless,
            debug: options.debug,
            apiConfigFile: options.apiConfig || undefined
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

    // 记录模式需要可见浏览器供用户操作，默认不使用无头模式
    const recorder = new RecorderMode({
      url: options.recordUrl || undefined,
      excelFile: options.apiConfig || undefined,
      outputFile: options.recordOutput,
      headless: false,
      debug: options.debug
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

    const stopFile = resolve(process.cwd(), 'records', '.stop-recording');
    console.log(chalk.yellow('记录模式运行中，按 Ctrl+C 停止'));
    console.log(chalk.cyan('  若需完整 trace（含截图），请用另一终端执行: touch records/.stop-recording'));
    console.log('');

    await new Promise<void>((_, reject) => {
      const t = setInterval(async () => {
        if (!existsSync(stopFile)) return;
        clearInterval(t);
        try {
          if (existsSync(stopFile)) unlinkSync(stopFile);
        } catch {}
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
 * 根据 Excel 中标记的用例启动记录模式
 * 使用同一份 Excel 作为测试用例与 API 配置来源
 */
async function runRecordFromExcel(options: CommandLineOptions): Promise<void> {
  try {
    if (!options.excelFile) {
      console.error(chalk.red('错误: 使用 --record-from-excel 时必须指定 --excel <测试用例文件>'));
      process.exit(1);
    }

    const excelPath = options.excelFile;
    const { testCases } = await ensureDataFileFromExcel(excelPath);
    const toRecord = testCases.filter(tc => tc.recordEnabled);

    if (toRecord.length === 0) {
      console.warn(chalk.yellow('警告: Excel 中未找到标记为“是否录制”的用例（第10列“是否录制”）'));
      return;
    }

    const target = toRecord[0];

    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.bold.cyan('从 Excel 启动操作记录模式'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log('');
    console.log(chalk.cyan(`将为用例 ${target.id} - ${target.name} 启动浏览器:`));
    console.log('  URL:', target.url);
    console.log('');

    const recordOptions: CommandLineOptions = {
      ...options,
      record: true,
      recordUrl: target.url,
      // 使用同一份 Excel 作为 API 配置来源，便于记录 apiRecords
      apiConfig: excelPath
    };

    await runRecordMode(recordOptions);
  } catch (error: any) {
    console.error(chalk.red('\n✗ 记录模式（来自 Excel）执行失败:'), error);
    console.error(error.stack);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold.cyan('UI自动化测试工具 - 使用说明')}

${chalk.bold('基本用法:')}
  node dist/index.js --excel <测试用例文件>
  node dist/index.js --template  # 创建Excel模板
  node dist/index.js --record <URL>  # 启动操作记录模式
  node dist/index.js --excel <测试用例文件> --record-from-excel  # 按Excel中“是否录制”列启动记录模式
  node dist/index.js --interactive  # 启动交互式测试模式

${chalk.bold('命令行选项:')}
  --excel, -e <文件>        Excel测试用例文件路径 (测试模式必需)
  --output, -o <目录>       报告输出目录 (默认: ./reports)
  --headless <true|false>   是否无头模式 (默认: true)
  --debug, -d              启用调试模式
  --max-concurrency <数值>  最大并发用例数/浏览器实例数 (默认: 5)
  --template, -t            创建Excel模板文件
  --record, -r <URL>        启动操作记录模式，URL 为可选初始地址
  --record-output <目录>    记录模式：输出目录，生成 record-时间戳.json 与 record-时间戳.zip (默认: ./records)
  --record-from-excel       根据Excel中“是否录制”列（第10列），按用例URL启动记录模式
  --interactive, -i         启动交互式测试模式
  --interactive-url <URL>   交互模式：初始URL（可选）
  --api-config <文件>       API配置Excel文件（用于mock，测试和记录模式都支持）
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

  # 运行测试
  node dist/index.js --excel test-cases.xlsx

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
