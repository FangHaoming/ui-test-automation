/**
 * 数据存储 - 将 Excel 解析结果存为 JSON 到 data 目录，并支持写入测试结果与记录
 */

import { join, basename, extname } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { parseTestCases } from './excelParser.js';
import type { TestCase } from './excelParser.js';
import type { TestResult, TestStatistics } from './testExecutor.js';
import type { NetworkRequest, NetworkResponse } from './networkInterceptor.js';
import type { AssertionPlan } from './aiAssertionEngine.js';

/** 持久化时的测试结果：只保留与回放和断言相关的字段 */
export interface TestResultJson {
  /** 用例整体状态（passed/failed 等） */
  status: TestResult['status'];
  /** 每个步骤的 actResult 数组（与原始步骤一一对应） */
  steps: ActResultJson[];
  /** 实际断言结果文本（日志） */
  actualResult: string;
  /** 整体错误信息（若有） */
  error: string | null;
  /** 本次执行开始/结束时间（ISO 字符串） */
  startTime: string;
  endTime: string | null;
  /** 总耗时（ms） */
  duration: number;
  /** 本次执行使用的断言计划（由 AI 生成），用于下次复用 */
  assertionPlan?: AssertionPlan;
  /** Playwright Trace 回放文件路径，可用 npx playwright show-trace <path> 查看 */
  tracePath?: string;
}

/** 可 JSON 序列化的测试用例（apiRequestSchemas 为普通对象） */
export interface TestCaseJson {
  id: string;
  name: string;
  url: string;
  steps: string[];
  expectedResult: string;
  description: string;
  apiRequestSchemas?: Record<string, string>;
  /** 该用例最近一次运行结果；result.steps 仅存 actResult 数组 */
  result?: TestResultJson;
}

/** 单次 API 记录（请求/响应） */
export interface ApiRecordItem {
  requestSchema?: string;
  response?: { url: string; status: number; headers: Record<string, string>; body: unknown };
}

/** Stagehand act() 单条 Action（用于回放，不调 LLM） */
export interface ActionJson {
  selector: string;
  description: string;
  method: string;
  arguments: string[];
}

/** Stagehand act() 返回的 ActResult（可序列化） */
export interface ActResultJson {
  success: boolean;
  message: string;
  actionDescription: string;
  actions: ActionJson[];
  /** 本步操作后是否尝试等待页面加载（来自执行结果 StepResult） */
  pageLoadWaitAttempted?: boolean;
  /** 本步操作等待页面加载是否发生超时（来自执行结果 StepResult） */
  pageLoadWaitTimedOut?: boolean;
}

/** 数据文件结构 */
export interface DataFile {
  sourceFile: string;
  testCases: TestCaseJson[];
  statistics?: TestStatistics;
  lastRun?: string;
  /** 记录模式写入：测试用例ID -> API URL -> 请求/响应记录 */
  apiRecords?: Record<string, Record<string, ApiRecordItem>>;
}

const DATA_DIR = 'data';

/**
 * 根据 Excel 路径得到对应的 data 目录下 JSON 路径
 * 例如: ./test-cases.xlsx -> data/test-cases.json
 */
export function getDataPath(excelPath: string): string {
  const name = basename(excelPath, extname(excelPath));
  return join(process.cwd(), DATA_DIR, `${name}.json`);
}

/**
 * 确保 data 目录存在
 */
export async function ensureDataDir(): Promise<string> {
  const dir = join(process.cwd(), DATA_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

function testCaseToJson(tc: TestCase): TestCaseJson {
  return {
    id: tc.id,
    name: tc.name,
    url: tc.url,
    steps: tc.steps,
    expectedResult: tc.expectedResult,
    description: tc.description,
    apiRequestSchemas: tc.apiRequestSchemas && tc.apiRequestSchemas.size > 0
      ? Object.fromEntries(tc.apiRequestSchemas)
      : undefined
  };
}

function testCaseFromJson(json: TestCaseJson): TestCase {
  return {
    id: json.id,
    name: json.name,
    url: json.url,
    steps: json.steps,
    expectedResult: json.expectedResult,
    description: json.description,
    apiRequestSchemas: json.apiRequestSchemas && Object.keys(json.apiRequestSchemas).length > 0
      ? new Map(Object.entries(json.apiRequestSchemas))
      : undefined
  };
}

/**
 * 从 Excel 解析测试用例，并保存为 data 目录下的 JSON
 * @param excelPath - Excel 文件路径
 * @returns 测试用例数组与数据文件路径
 */
export async function loadTestCasesFromExcelAndSave(excelPath: string): Promise<{
  testCases: TestCase[];
  dataPath: string;
}> {
  const testCases = await parseTestCases(excelPath);
  const dataPath = getDataPath(excelPath);
  await ensureDataDir();

  const sourceFile = basename(excelPath);
  let data: DataFile = {
    sourceFile,
    testCases: testCases.map(tc => testCaseToJson(tc))
  };
  // 若已有 data 文件，保留每个用例的 result、apiRecords
  if (existsSync(dataPath)) {
    try {
      const existing = await loadDataFile(dataPath);
      const existingById = new Map((existing.testCases || []).map(tc => [tc.id, tc]));
      data = {
        ...existing,
        sourceFile,
        testCases: data.testCases.map(tc => ({
          ...tc,
          result: existingById.get(tc.id)?.result
        }))
      };
    } catch {
      // 解析失败则用新 data
    }
  }

  await writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
  return { testCases, dataPath };
}

/**
 * 读取 data 文件
 */
export async function loadDataFile(dataPath: string): Promise<DataFile> {
  const content = await readFile(dataPath, 'utf-8');
  return JSON.parse(content) as DataFile;
}

/**
 * 写入 data 文件
 */
export async function saveDataFile(dataPath: string, data: DataFile): Promise<void> {
  await ensureDataDir();
  await writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 将测试结果与统计信息写入对应的 data JSON
 */
export async function saveTestResults(
  dataPath: string,
  results: TestResult[],
  statistics: TestStatistics
): Promise<void> {
  let data: DataFile;
  if (existsSync(dataPath)) {
    data = await loadDataFile(dataPath);
  } else {
    data = { sourceFile: '', testCases: [] };
  }
  data.statistics = statistics;
  data.lastRun = new Date().toISOString();
  // 将每条结果放到对应 testCase.result 下；result.steps 简化为仅保留 actResult 数组
  const resultById = new Map(results.map(r => [r.id, r]));
  const existingById = new Map(data.testCases.map(tc => [tc.id, tc]));
  data.testCases = data.testCases.map(tc => {
    const r = resultById.get(tc.id);
    const prevResult = existingById.get(tc.id)?.result as TestResultJson | undefined;
    if (!r) return { ...tc, result: prevResult };
    const steps = r.steps
      .map((s, index) => {
        const act = s.actResult;
        if (!act || !Array.isArray(act.actions)) return undefined;
        // 将每步的页面加载等待信息合并到持久化的 ActResultJson 中
        // 注意：这里要与历史结果做“累积”，避免第二次执行把第一次的超时标记覆盖掉
        const stepAny = s as any;
        const prevStep = prevResult?.steps?.[index] as ActResultJson | undefined;

        const currentAttempted =
          typeof stepAny.pageLoadWaitAttempted === 'boolean'
            ? stepAny.pageLoadWaitAttempted
            : undefined;
        const currentTimedOut =
          typeof stepAny.pageLoadWaitTimedOut === 'boolean'
            ? stepAny.pageLoadWaitTimedOut
            : undefined;

        const prevAttempted =
          typeof prevStep?.pageLoadWaitAttempted === 'boolean'
            ? prevStep.pageLoadWaitAttempted
            : undefined;
        const prevTimedOut =
          typeof prevStep?.pageLoadWaitTimedOut === 'boolean'
            ? prevStep.pageLoadWaitTimedOut
            : undefined;

        // 规则：
        // - 只要历史或当前有一次 attempted === true，就认为 attempted 为 true
        // - 只要历史或当前有一次 timedOut === true，就一直保持为 true（不会被后续 false 覆盖）
        const pageLoadWaitAttempted =
          currentAttempted === true || prevAttempted === true
            ? true
            : currentAttempted ?? prevAttempted;
        const pageLoadWaitTimedOut =
          currentTimedOut === true || prevTimedOut === true
            ? true
            : currentTimedOut ?? prevTimedOut;

        return {
          ...act,
          pageLoadWaitAttempted,
          pageLoadWaitTimedOut
        } as ActResultJson;
      })
      .filter((a): a is ActResultJson => !!a && Array.isArray(a.actions));
    const resultJson: TestResultJson = {
      status: r.status,
      steps,
      actualResult: r.actualResult,
      error: r.error,
      startTime: r.startTime instanceof Date ? r.startTime.toISOString() : String(r.startTime),
      endTime: r.endTime instanceof Date ? r.endTime.toISOString() : (r.endTime ? String(r.endTime) : null),
      duration: r.duration,
      assertionPlan: r.assertionPlan || prevResult?.assertionPlan,
      tracePath: r.tracePath
    };
    return { ...tc, result: resultJson };
  });
  await saveDataFile(dataPath, data);
}

/**
 * 从 data JSON 加载测试用例（若存在）；否则从 Excel 解析并保存
 * 用于记录模式：先确保有 data 文件，再往其中写 apiRecords
 */
export async function ensureDataFileFromExcel(excelPath: string): Promise<{
  testCases: TestCase[];
  dataPath: string;
}> {
  const dataPath = getDataPath(excelPath);
  if (existsSync(dataPath)) {
    const data = await loadDataFile(dataPath);
    const testCases = (data.testCases || []).map(testCaseFromJson);
    return { testCases, dataPath };
  }
  return loadTestCasesFromExcelAndSave(excelPath);
}

/**
 * 将记录模式捕获的 API 请求/响应写入对应的 data JSON
 */
export async function saveApiRecords(
  dataPath: string,
  testCaseRequestMap: Map<string, Map<string, NetworkRequest>>,
  testCaseResponseMap: Map<string, Map<string, NetworkResponse>>,
  generateRequestSchema: (body: unknown) => string
): Promise<void> {
  const data = existsSync(dataPath) ? await loadDataFile(dataPath) : { sourceFile: '', testCases: [] };
  const apiRecords: DataFile['apiRecords'] = data.apiRecords || {};

  testCaseRequestMap.forEach((reqMap, testCaseId) => {
    if (!apiRecords[testCaseId]) apiRecords[testCaseId] = {};
    reqMap.forEach((req, apiUrl) => {
      let requestSchema = '';
      try {
        let body: unknown = {};
        if (req.postData) {
          try {
            body = JSON.parse(req.postData);
          } catch {
            body = { raw: req.postData };
          }
        }
        requestSchema = generateRequestSchema(body);
      } catch {
        requestSchema = JSON.stringify({ method: req.method, headers: req.headers, body: req.postData }, null, 2);
      }
      if (!apiRecords[testCaseId][apiUrl]) apiRecords[testCaseId][apiUrl] = {};
      apiRecords[testCaseId][apiUrl].requestSchema = requestSchema;
    });
  });

  testCaseResponseMap.forEach((resMap, testCaseId) => {
    if (!apiRecords[testCaseId]) apiRecords[testCaseId] = {};
    resMap.forEach((res, apiUrl) => {
      if (!apiRecords[testCaseId][apiUrl]) apiRecords[testCaseId][apiUrl] = {};
      apiRecords[testCaseId][apiUrl].response = {
        url: res.url,
        status: res.status,
        headers: res.headers || {},
        body: res.body
      };
    });
  });

  data.apiRecords = apiRecords;
  await saveDataFile(dataPath, data);
}
