import { execSync } from 'child_process';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { chromium } from '@playwright/test';

/**
 * 检测 Playwright 浏览器是否已安装（以 Chromium 可执行文件是否存在为准）
 */
export function arePlaywrightBrowsersInstalled(): boolean {
  try {
    const path = chromium.executablePath();
    return typeof path === 'string' && path.length > 0 && existsSync(path);
  } catch {
    return false;
  }
}

/**
 * 安装 Playwright 浏览器
 * 使用 npx 直接调用 playwright，避免在脚本中通过 yarn 调用时的信号/退出码问题
 * @returns Promise<void>
 */
export async function installPlaywrightBrowsers(): Promise<void> {
  console.log(chalk.yellow('\n正在安装 Playwright 浏览器...'));
  console.log(chalk.cyan('这可能需要几分钟时间，请耐心等待...\n'));

  try {
    execSync('npx playwright install', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env }
    });
    console.log(chalk.green('\n✓ Playwright 浏览器安装完成！\n'));
  } catch (error: any) {
    const cancelled = error?.status === 130 || error?.signal === 'SIGINT';
    if (cancelled) {
      console.error(chalk.yellow('\n安装已取消（用户中断 Ctrl+C）'));
      throw new Error('用户取消了 Playwright 浏览器安装');
    }
    console.error(chalk.red('\n✗ 安装失败:'), error?.message ?? error);
    console.error(chalk.yellow('\n请手动在项目目录下运行以下命令安装浏览器：'));
    console.error(chalk.cyan('  npx playwright install'));
    console.error(chalk.gray('  或: yarn playwright install'));
    throw new Error(`浏览器安装失败: ${error?.message ?? String(error)}`);
  }
}

/**
 * 确保 Playwright 浏览器已安装：若已安装则跳过，否则执行安装
 */
export async function ensurePlaywrightBrowsersInstalled(): Promise<void> {
  if (arePlaywrightBrowsersInstalled()) {
    return;
  }
  await installPlaywrightBrowsers();
}
