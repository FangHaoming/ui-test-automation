/**
 * 测试执行器相关类型定义
 */

import type { AssertionPlan } from '../ai/aiAssertionEngine.js';
import type { ActResultJson, ActionJson } from '../data/dataStore.js';
import type { ApiEndpoint } from '../utils/networkInterceptor.js';

export type { AssertionPlan, ActResultJson, ActionJson };

/**
 * 测试步骤结果接口
 */
export interface StepResult {
  stepNumber: number;
  description: string;
  status: 'pending' | 'passed' | 'failed';
  error: string | null;
  /** 步骤通过时 stagehand.act 的返回值，用于后续直接复用（不调 LLM） */
  actResult?: ActResultJson;
  /** 本步操作后是否尝试等待页面加载 */
  pageLoadWaitAttempted?: boolean;
  /** 本步操作等待页面加载是否发生超时 */
  pageLoadWaitTimedOut?: boolean;
}

/**
 * 测试结果接口
 */
export interface TestResult {
  id: string;
  name: string;
  url: string;
  status: 'pending' | 'passed' | 'failed';
  steps: StepResult[];
  expectedResult: string;
  actualResult: string;
  error: string | null;
  startTime: Date;
  endTime: Date | null;
  duration: number;
  /** 断言计划（由 AI 生成），用于下次复用，避免重复走 LLM 规划 */
  assertionPlan?: AssertionPlan;
  /** Playwright Trace Viewer 记录文件路径，可用 npx playwright show-trace <path> 查看 */
  tracePath?: string;
  /** 测试失败时的执行日志（仅失败时写入，用于持久化到 result） */
  log?: string;
}

/**
 * 测试执行器配置选项
 */
export interface TestExecutorOptions {
  headless?: boolean;
  debug?: boolean;
  timeout?: number;
  apiConfigFile?: string; // API配置Excel文件路径
  /** 是否记录 Playwright Trace（用于调试），默认 true */
  recordTrace?: boolean;
  /** Trace 文件输出目录，默认 ./traces */
  traceDir?: string;
  /** 可选：直接传入要拦截的 API endpoint 列表（通常来自 data JSON 的 apiUrls），优先级高于 apiConfigFile */
  apiEndpoints?: ApiEndpoint[];
  /** 是否在执行结束后，将本次网络请求持久化到 data JSON（需要配合外层逻辑使用） */
  recordApi?: boolean;
  /**
   * 仅校验 API 请求（忽略 expectedResult 文本断言）
   * 用于页面改版但接口不变场景
   */
  onlyApi?: boolean;
}

/**
 * 测试统计信息接口
 */
export interface TestStatistics {
  total: number;
  passed: number;
  failed: number;
  passRate: string;
  totalDuration: string;
  averageDuration: string;
}
