import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import chalk from 'chalk';
import * as readline from 'readline';
import { TestExecutor, type TestExecutorOptions } from './testExecutor.js';

/**
 * 交互式测试模式配置选项
 */
export interface InteractiveModeOptions {
  headless?: boolean;
  debug?: boolean;
  apiConfigFile?: string;
  initialUrl?: string;
}

/**
 * 交互式测试模式类
 */
export class InteractiveMode {
  private executor: TestExecutor;
  private stagehand: Stagehand | null = null;
  private page: any = null;

  constructor(options: InteractiveModeOptions = {}) {
    const executorOptions: TestExecutorOptions = {
      headless: options.headless !== false,
      debug: options.debug || false,
      apiConfigFile: options.apiConfigFile
    };
    this.executor = new TestExecutor(executorOptions);
  }

  /**
   * 启动交互式测试模式
   * @param initialUrl - 初始URL（可选）
   */
  async start(initialUrl?: string): Promise<void> {
    // 初始化 Stagehand（通过 TestExecutor）
    await (this.executor as any).init();
    
    // 获取 stagehand 和 page 实例
    this.stagehand = this.executor.getStagehand();
    this.page = this.executor.getPage();

    if (!this.stagehand || !this.page) {
      throw new Error('Stagehand 初始化失败');
    }

    console.log(chalk.cyan('\n' + '='.repeat(80)));
    console.log(chalk.bold.cyan('交互式测试模式'));
    console.log(chalk.cyan('='.repeat(80)));
    console.log(chalk.green('✓ 浏览器已打开\n'));

    // 如果提供了初始URL，导航到该URL
    if (initialUrl) {
      try {
        console.log(chalk.blue(`导航到: ${initialUrl}`));
        await this.page.goto(initialUrl);
        console.log(chalk.green('✓ 页面加载完成\n'));
      } catch (error: any) {
        console.warn(chalk.yellow(`⚠️  页面加载警告: ${error.message}\n`));
      }
    }

    // 创建 readline 接口
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan('stagehand> ')
    });

    // 显示帮助信息
    console.log(chalk.yellow('可用命令:'));
    console.log(chalk.gray('  act <指令>      - 执行操作（例如: act 点击登录按钮）'));
    console.log(chalk.gray('  observe <描述>  - 观察页面（例如: observe 描述当前页面状态）'));
    console.log(chalk.gray('  goto <URL>      - 导航到指定URL'));
    console.log(chalk.gray('  extract         - 提取页面内容'));
    console.log(chalk.gray('  url             - 显示当前页面URL'));
    console.log(chalk.gray('  help            - 显示帮助信息'));
    console.log(chalk.gray('  exit / quit     - 退出交互模式\n'));

    // 处理用户输入
    rl.prompt();

    rl.on('line', async (input: string) => {
      const trimmedInput = input.trim();
      
      if (!trimmedInput) {
        rl.prompt();
        return;
      }

      // 解析命令
      const parts = trimmedInput.split(/\s+(.+)/);
      const command = parts[0].toLowerCase();
      const args = parts[1] || '';

      try {
        switch (command) {
          case 'act':
            if (!args) {
              console.log(chalk.yellow('用法: act <指令>'));
              console.log(chalk.gray('示例: act 点击登录按钮'));
            } else {
              await this.handleAct(args);
            }
            break;

          case 'observe':
            if (!args) {
              console.log(chalk.yellow('用法: observe <描述>'));
              console.log(chalk.gray('示例: observe 描述当前页面上的所有按钮'));
            } else {
              await this.handleObserve(args);
            }
            break;

          case 'goto':
          case 'navigate':
            if (!args) {
              console.log(chalk.yellow('用法: goto <URL>'));
              console.log(chalk.gray('示例: goto https://example.com'));
            } else {
              await this.handleGoto(args);
            }
            break;

          case 'extract':
            await this.handleExtract();
            break;

          case 'url':
            await this.handleUrl();
            break;

          case 'help':
          case '?':
            this.printHelp();
            break;

          case 'exit':
          case 'quit':
          case 'q':
            console.log(chalk.yellow('\n正在退出交互模式...'));
            rl.close();
            await this.close();
            console.log(chalk.green('✓ 已退出'));
            process.exit(0);
            return;

          default:
            // 如果没有匹配的命令，尝试作为 act 命令执行
            await this.handleAct(trimmedInput);
            break;
        }
      } catch (error: any) {
        console.error(chalk.red(`\n✗ 执行出错: ${error.message || String(error)}`));
        const debug = (this.executor as any).options?.debug || false;
        if (debug && error.stack) {
          console.error(chalk.gray(error.stack));
        }
      }

      console.log(''); // 空行
      rl.prompt();
    });

    rl.on('close', async () => {
      console.log(chalk.yellow('\n\n收到退出信号，正在关闭...'));
      await this.close();
      process.exit(0);
    });

    // 处理 Ctrl+C
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n收到停止信号，正在关闭...'));
      rl.close();
      await this.close();
      process.exit(0);
    });
  }

  /**
   * 处理 act 命令
   */
  private async handleAct(instruction: string): Promise<void> {
    console.log(chalk.blue(`\n执行操作: ${instruction}`));
    const startTime = Date.now();
    try {
      const result = await this.stagehand!.act(instruction);
      const duration = Date.now() - startTime;
      
      if (result) {
        if (Array.isArray(result)) {
          console.log(chalk.green(`✓ 执行了 ${result.length} 个操作 (耗时: ${duration}ms)`));
          result.forEach((action: any, idx: number) => {
            const actionDesc = action?.description || action?.type || JSON.stringify(action);
            console.log(chalk.gray(`  ${idx + 1}. ${actionDesc}`));
          });
        } else if (typeof result === 'object' && result.success === false) {
          const errorMsg = (result as any).message || (result as any).error || '未知错误';
          console.error(chalk.red(`✗ 操作失败: ${errorMsg}`));
        } else {
          console.log(chalk.green(`✓ 操作完成 (耗时: ${duration}ms)`));
          const debug = (this.executor as any).options?.debug || false;
          if (debug) {
            console.log(chalk.gray(JSON.stringify(result, null, 2).substring(0, 500)));
          }
        }
      } else {
        console.log(chalk.green(`✓ 操作完成 (耗时: ${duration}ms)`));
      }
    } catch (error: any) {
      console.error(chalk.red(`✗ 操作失败: ${error.message || String(error)}`));
    }
  }

  /**
   * 处理 observe 命令
   */
  private async handleObserve(description: string): Promise<void> {
    console.log(chalk.blue(`\n观察页面: ${description}`));
    try {
      const observations = await this.stagehand!.observe(description);
      if (observations && observations.length > 0) {
        console.log(chalk.green(`✓ 观察到 ${observations.length} 个结果:`));
        observations.forEach((obs: any, idx: number) => {
          console.log(chalk.cyan(`\n[${idx + 1}]`));
          console.log(chalk.white(obs.description || JSON.stringify(obs)));
        });
      } else {
        console.log(chalk.yellow('未观察到任何内容'));
      }
    } catch (error: any) {
      console.error(chalk.red(`✗ 观察失败: ${error.message || String(error)}`));
    }
  }

  /**
   * 处理 goto 命令
   */
  private async handleGoto(url: string): Promise<void> {
    let targetUrl = url.trim();
    // 如果不是完整URL，尝试添加协议
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }
    console.log(chalk.blue(`\n导航到: ${targetUrl}`));
    try {
      await this.page.goto(targetUrl);
      console.log(chalk.green('✓ 页面加载完成'));
    } catch (error: any) {
      console.error(chalk.red(`✗ 导航失败: ${error.message || String(error)}`));
    }
  }

  /**
   * 处理 extract 命令
   */
  private async handleExtract(): Promise<void> {
    console.log(chalk.blue('\n提取页面内容...'));
    try {
      const extracted = await this.stagehand!.extract();
      console.log(chalk.green('✓ 提取完成:'));
      if (typeof extracted === 'object') {
        console.log(chalk.white(JSON.stringify(extracted, null, 2)));
      } else {
        console.log(chalk.white(String(extracted)));
      }
    } catch (error: any) {
      console.error(chalk.red(`✗ 提取失败: ${error.message || String(error)}`));
    }
  }

  /**
   * 处理 url 命令
   */
  private async handleUrl(): Promise<void> {
    try {
      const currentUrl = this.page.url();
      console.log(chalk.cyan(`\n当前URL: ${currentUrl}`));
    } catch (error: any) {
      console.error(chalk.red(`✗ 获取URL失败: ${error.message || String(error)}`));
    }
  }

  /**
   * 显示帮助信息
   */
  private printHelp(): void {
    console.log(chalk.yellow('\n可用命令:'));
    console.log(chalk.gray('  act <指令>      - 执行操作（例如: act 点击登录按钮）'));
    console.log(chalk.gray('  observe <描述>  - 观察页面（例如: observe 描述当前页面状态）'));
    console.log(chalk.gray('  goto <URL>      - 导航到指定URL'));
    console.log(chalk.gray('  extract         - 提取页面内容'));
    console.log(chalk.gray('  url             - 显示当前页面URL'));
    console.log(chalk.gray('  help            - 显示帮助信息'));
    console.log(chalk.gray('  exit / quit     - 退出交互模式\n'));
  }

  /**
   * 关闭浏览器
   */
  async close(): Promise<void> {
    await this.executor.close();
  }
}
