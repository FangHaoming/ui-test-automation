import 'dotenv/config';
import { createTemplateWithApiConfig, parseApiEndpoints } from './excelParser.js';
import {
  loadTestCasesFromExcelAndSave,
  saveTestResults,
  loadDataFile,
  type ActResultJson,
  type TestResultJson
} from './dataStore.js';
import type { AssertionPlan } from './aiAssertionEngine.js';
import { TestExecutor } from './testExecutor.js';
import { ReportGenerator } from './reportGenerator.js';
import { RecorderMode } from './recorderMode.js';
import { InteractiveMode } from './interactiveMode.js';
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';


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
  recordUrl: string | null;
  recordOutput: string;
  apiConfig: string | null;
  interactive: boolean;
  interactiveUrl: string | null;
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
    recordUrl: null,
    recordOutput: './recorded-actions.json',
    apiConfig: null,
    interactive: false,
    interactiveUrl: null
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
        break;
      case '--record-url':
        options.recordUrl = args[++i];
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
    const templatePath = join(process.cwd(), 'test-cases-template.xlsx');
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

    // 从每个 testCase.result.steps 汇总 recordedActions（持久化格式中 steps 即 actResult 数组）
    const data = await loadDataFile(dataPath);
    const recordedActions: Record<string, ActResultJson[]> = {};
    const assertionPlans: Record<string, AssertionPlan> = {};

    data.testCases.forEach(tc => {
      const result = tc.result as TestResultJson | undefined;
      if (!result) return;

      // 记录断言计划（若存在），供下次复用
      if (result.assertionPlan) {
        assertionPlans[tc.id] = result.assertionPlan;
      }

      const steps = result.steps;
      if (!steps?.length) return;

      // 新格式：steps 已是 ActResultJson[]
      const first = steps[0] as { actions?: unknown[]; actResult?: ActResultJson };
      if (Array.isArray(first?.actions)) {
        recordedActions[tc.id] = steps as ActResultJson[];
        return;
      }

      // 旧格式：steps 为 StepResult[]，取 actResult
      const list = (steps as { actResult?: ActResultJson }[])
        .map(s => s.actResult)
        .filter((a): a is ActResultJson => !!a && Array.isArray(a.actions));
      if (list.length) recordedActions[tc.id] = list;
    });
    // 兼容更旧格式：用例下的 recordedActions 或顶层的 recordedActions
    data.testCases.forEach(tc => {
      if (recordedActions[tc.id]) return;
      const legacy = (tc as { recordedActions?: ActResultJson[] }).recordedActions;
      if (legacy?.length) recordedActions[tc.id] = legacy;
    });
    const topLevel = (data as { recordedActions?: Record<string, ActResultJson[]> }).recordedActions;
    if (Object.keys(recordedActions).length === 0 && topLevel) {
      Object.assign(recordedActions, topLevel);
    }

    // 创建测试执行器
    const executor = new TestExecutor({
      headless: options.headless,
      debug: options.debug,
      apiConfigFile: options.apiConfig || undefined
    });

    // 执行测试（传入 recordedActions / assertionPlans）
    const results = await executor.executeAll(testCases, {
      recordedActions,
      assertionPlans
    });
    
    // 获取统计信息
    const statistics = executor.getStatistics();

    // 将测试结果写入 data 目录下对应的 JSON
    console.log('\n正在写入测试结果到 JSON...');
    await saveTestResults(dataPath, results, statistics);
    console.log(chalk.green(`✓ 测试结果已写入: ${dataPath}`));

    // 生成报告
    console.log('\n正在生成测试报告...');
    ReportGenerator.printConsoleReport(results, statistics);

    // HTML 报告（仍输出到 output 目录）
    const { mkdir } = await import('fs/promises');
    await mkdir(options.outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const htmlReportPath = join(options.outputDir, `test-report-${timestamp}.html`);
    await ReportGenerator.generateHTMLReport(results, statistics, htmlReportPath);

    // 关闭浏览器
    await executor.close();

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

    const recorder = new RecorderMode({
      url: options.recordUrl || undefined,
      excelFile: options.apiConfig || undefined,
      outputFile: options.recordOutput,
      headless: options.headless,
      debug: options.debug
    });

    // 处理Ctrl+C信号
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n收到停止信号，正在保存记录...'));
      await recorder.stop();
      process.exit(0);
    });

    await recorder.start();

    // 保持运行直到用户停止
    console.log(chalk.yellow('记录模式运行中，按 Ctrl+C 停止...'));
    
    // 保持进程运行
    await new Promise(() => {}); // 永远等待，直到被SIGINT中断

  } catch (error: any) {
    console.error(chalk.red('\n✗ 记录模式执行失败:'), error);
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
  node dist/index.js --record    # 启动操作记录模式
  node dist/index.js --interactive  # 启动交互式测试模式

${chalk.bold('命令行选项:')}
  --excel, -e <文件>        Excel测试用例文件路径 (测试模式必需)
  --output, -o <目录>       报告输出目录 (默认: ./reports)
  --headless <true|false>   是否无头模式 (默认: true)
  --debug, -d              启用调试模式
  --template, -t            创建Excel模板文件
  --record, -r              启动操作记录模式
  --record-url <URL>        记录模式：初始URL（可选）
  --record-output <文件>    记录模式：输出文件路径 (默认: ./recorded-actions.json)
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
  node dist/index.js --record --record-url https://example.com

  # 启动记录模式并配置API mock
  node dist/index.js --record --record-url https://example.com --api-config api-config.xlsx

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
