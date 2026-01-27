import { execSync } from 'child_process';
import chalk from 'chalk';

/**
 * 安装 Playwright 浏览器
 * @returns Promise<void>
 */
export async function installPlaywrightBrowsers(): Promise<void> {
  console.log(chalk.yellow('\n正在安装 Playwright 浏览器...'));
  console.log(chalk.cyan('这可能需要几分钟时间，请耐心等待...\n'));

  try {
    execSync('yarn playwright install', { 
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env }
    });
    console.log(chalk.green('\n✓ Playwright 浏览器安装完成！\n'));
  } catch (error: any) {
    console.error(chalk.red('\n✗ 安装失败:'), error.message);
    console.error(chalk.yellow('\n请手动运行以下命令安装浏览器：'));
    console.error(chalk.cyan('  yarn playwright install'));
    throw new Error(`浏览器安装失败: ${error.message}`);
  }
}

/**
 * 确保 Playwright 浏览器已安装，直接执行安装
 * @returns Promise<void>
 */
export async function ensurePlaywrightBrowsersInstalled(): Promise<void> {
  await installPlaywrightBrowsers();
}
