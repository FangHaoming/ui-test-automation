/**
 * 使用 Playwright API 执行单条 Action，及 act 结果规范化
 */

import type { ActResultJson, ActionJson } from '../data/dataStore.js';

/**
 * 使用 Playwright API 执行单条 Action，使 Trace Viewer 的 Actions 面板有记录
 */
export async function executeActionWithPlaywright(
  pwPage: import('playwright').Page,
  action: ActionJson
): Promise<void> {
  const loc = pwPage.locator(action.selector).first();
  const method = (action.method || 'click').toLowerCase();
  const args = action.arguments || [];

  switch (method) {
    case 'click':
      await loc.click();
      break;
    case 'fill':
    case 'input':
    case 'type':
      await loc.fill(args[0] ?? '');
      break;
    case 'press':
      await loc.press(args[0] ?? 'Enter');
      break;
    case 'check':
      await loc.check();
      break;
    case 'uncheck':
      await loc.uncheck();
      break;
    case 'selectoption':
    case 'select':
      await loc.selectOption(args[0] ?? args);
      break;
    case 'hover':
      await loc.hover();
      break;
    case 'dblclick':
    case 'doubleclick':
      await loc.dblclick();
      break;
    default:
      await loc.click();
  }
}

/**
 * 将 stagehand.act 返回值规范为 ActResultJson（便于存储与回放）
 */
export function normalizeActResult(raw: any, stepDescription: string): ActResultJson | undefined {
  if (!raw) return undefined;
  let actions: ActResultJson['actions'] = [];
  if (Array.isArray(raw)) {
    actions = raw.map((a: any) => ({
      selector: a?.selector ?? '',
      description: a?.description ?? '',
      method: a?.method ?? '',
      arguments: Array.isArray(a?.arguments) ? a.arguments : []
    }));
  } else if (typeof raw === 'object' && Array.isArray(raw.actions)) {
    actions = raw.actions.map((a: any) => ({
      selector: a?.selector ?? '',
      description: a?.description ?? '',
      method: a?.method ?? '',
      arguments: Array.isArray(a?.arguments) ? a.arguments : []
    }));
  }
  if (actions.length === 0) return undefined;
  return {
    success: raw?.success !== false,
    message: raw?.message ?? '',
    actionDescription: raw?.actionDescription ?? stepDescription,
    actions
  };
}
