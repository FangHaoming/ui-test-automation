/**
 * act 后根据 URL 变化等待页面加载
 */

import chalk from 'chalk';

export type LogFn = (...args: any[]) => void;

/**
 * act 后若检测到页面 URL 发生变化，则等待页面加载完成后再继续下一步。
 * 返回本次是否尝试等待以及是否发生超时。
 */
export async function waitForPageLoadIfUrlChanged(
  pageForWait: {
    url: () => string;
    waitForLoadState: (state: string, options?: { timeout?: number }) => Promise<void>;
    waitForTimeout: (ms: number) => Promise<void>;
  } | null,
  urlBeforeAct: string,
  log: LogFn,
  timeoutMs: number = 3_000
): Promise<{ attempted: boolean; timedOut: boolean }> {
  if (!pageForWait) {
    log(chalk.gray(`    [调试] waitForPageLoadIfUrlChanged: page 为空，跳过`));
    return { attempted: false, timedOut: false };
  }
  log(chalk.gray(`    [调试] act 前 URL: ${urlBeforeAct}`));
  let attempted = false;
  let timedOut = false;
  try {
    log(chalk.gray(`    [调试] 等待页面加载完成（最多 ${timeoutMs}ms）...`));
    attempted = true;
    await pageForWait.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch (_e) {
    log(chalk.yellow(`    [等待加载] 等待 networkidle 超时，继续执行`));
    timedOut = true;
  }
  const urlAfterLoad = pageForWait.url();
  log(chalk.gray(`    [调试] 加载完成后的 URL: ${urlAfterLoad}`));
  if (urlAfterLoad === urlBeforeAct) {
    log(chalk.gray(`    [调试] URL 未变化，不等待`));
    return { attempted, timedOut: true };
  }
  log(chalk.green(`    [已等待] 页面 URL 已变化，加载完成`));
  await pageForWait.waitForTimeout(500);
  return { attempted, timedOut };
}
