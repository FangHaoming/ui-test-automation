/**
 * 数据存储 - 将 Excel 解析结果存为 JSON 到 data 目录，并支持写入测试结果与记录
 */

import { join, basename, extname, resolve } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureDir } from '../utils/fsUtils.js';
import { parseTestCases, getTestCaseApiMapping } from './excelParser.js';
import type { TestCase } from './excelParser.js';
import type { TestResult, TestStatistics } from '../executor/testExecutor.js';
import type { NetworkRequest, NetworkResponse } from '../utils/networkInterceptor.js';
import type { AssertionPlan } from '../ai/aiAssertionEngine.js';

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
  /** 测试失败时的执行日志（仅失败时写入） */
  log?: string;
}

  /** 可 JSON 序列化的测试用例 */
export interface TestCaseJson {
  id: string;
  name: string;
  url: string;
  steps: string[];
  expectedResult: string;
  description: string;
  /** 该用例关注的 API URL 列表（来自 Excel 的「API URL」列），用于录制/回放时按用例分组记录网络请求 */
  apiUrls?: string[];
  /** 该用例在执行阶段「要校验」的 API URL 列表；若未配置，则默认对所有有 requestSchema 的 URL 做校验 */
  validateApiUrls?: string[];
  /** 该用例对应的 API 记录：API URL -> 请求/响应记录 */
  apiRecords?: Record<string, ApiRecordItem>;
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
  /** @deprecated 旧版本：记录模式写入的 API 记录（按 测试用例ID -> API URL 分组）；现已迁移到每个 testCase.apiRecords */
  apiRecords?: Record<string, Record<string, ApiRecordItem>>;
  /** @deprecated 旧版本：保存 API URL 映射；保留用于兼容，但逻辑上优先使用每个 testCase.apiUrls */
  apiUrlMapping?: Record<string, string[]>;
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
  return ensureDir(join(process.cwd(), DATA_DIR));
}

function testCaseToJson(tc: TestCase): TestCaseJson {
  return {
    id: tc.id,
    name: tc.name,
    url: tc.url,
    steps: tc.steps,
    expectedResult: tc.expectedResult,
    description: tc.description
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
  const mappingMap = await getTestCaseApiMapping(excelPath);

  // 先根据 Excel 解析得到基础用例，并把「API URL」列写进各自的 testCase.apiUrls
  let data: DataFile = {
    sourceFile,
    testCases: testCases.map(tc => {
      const base = testCaseToJson(tc);
      const urls = mappingMap.get(tc.id);
      return urls && urls.length > 0 ? { ...base, apiUrls: urls } : base;
    })
  };

  // 若已有 data 文件，保留每个用例的 result、apiRecords 等历史信息
  if (existsSync(dataPath)) {
    try {
      const existing = await loadDataFile(dataPath);
      const existingById = new Map((existing.testCases || []).map(tc => [tc.id, tc]));
      data = {
        ...existing,
        sourceFile,
        testCases: data.testCases.map(tc => ({
          // 以最新 Excel 为主，同步 API URL；但保留历史 result
          ...(existingById.get(tc.id) || {}),
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
 * 将 Excel 解析结果合并到指定 JSON：仅追加 JSON 中尚不存在的用例 ID，已存在的跳过。
 * @param excelPath - Excel 文件路径
 * @param dataPathOrUndefined - 目标 JSON 路径（可选）；不传则按 Excel 文件名推导到 data/<name>.json
 * @returns 合并数量、跳过数量与数据文件路径
 */
export async function mergeExcelToDataFile(
  excelPath: string,
  dataPathOrUndefined?: string
): Promise<{ mergedCount: number; skippedCount: number; dataPath: string }> {
  const testCases = await parseTestCases(excelPath);
  const mappingMap = await getTestCaseApiMapping(excelPath);
  const dataPath = dataPathOrUndefined
    ? resolve(process.cwd(), dataPathOrUndefined)
    : getDataPath(excelPath);
  await ensureDataDir();

  const sourceFile = basename(excelPath);
  let data: DataFile;

  if (existsSync(dataPath)) {
    data = await loadDataFile(dataPath);
  } else {
    data = { sourceFile, testCases: [] };
  }

  const existingIds = new Set((data.testCases || []).map(tc => tc.id));
  let mergedCount = 0;
  let skippedCount = 0;

  for (const tc of testCases) {
    if (existingIds.has(tc.id)) {
      skippedCount += 1;
      continue;
    }
    data.testCases = data.testCases || [];
    const base = testCaseToJson(tc);
    const urls = mappingMap.get(tc.id);
    data.testCases.push(
      urls && urls.length > 0
        ? { ...base, apiUrls: urls }
        : base
    );
    existingIds.add(tc.id);
    mergedCount += 1;
  }

  await writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
  return { mergedCount, skippedCount, dataPath };
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

    // 若本次执行未产生可持久化的 steps（如回放中途失败），保留原有的 result.steps，避免覆盖为空
    const stepsToWrite =
      steps.length > 0 ? steps : (prevResult?.steps?.length ? prevResult.steps : steps);

    const resultJson: TestResultJson = {
      status: r.status,
      steps: stepsToWrite,
      actualResult: r.actualResult,
      error: r.error,
      startTime: r.startTime instanceof Date ? r.startTime.toISOString() : String(r.startTime),
      endTime: r.endTime instanceof Date ? r.endTime.toISOString() : (r.endTime ? String(r.endTime) : null),
      duration: r.duration,
      assertionPlan: r.assertionPlan || prevResult?.assertionPlan,
      tracePath: r.tracePath,
      ...(r.log != null && r.log !== '' ? { log: r.log } : {})
    };
    return { ...tc, result: resultJson };
  });
  await saveDataFile(dataPath, data);
}

/**
 * 从 data 目录下的 JSON 文件直接加载测试用例（不经过 Excel）
 * @param dataPath - data 下的 JSON 路径，如 data/test-cases-template.json
 */
export async function loadTestCasesFromDataFile(dataPath: string): Promise<{
  testCases: TestCase[];
  dataPath: string;
}> {
  const resolvedPath = resolve(process.cwd(), dataPath);
  const data = await loadDataFile(resolvedPath);
  return { testCases: data.testCases, dataPath: resolvedPath };
}

/**
 * 从 data JSON 中删除指定 ID 的测试用例并保存
 * @param dataPath - data 下的 JSON 路径（相对或绝对）
 * @param caseId - 要删除的用例 ID
 * @returns 是否删除了用例
 */
export async function deleteTestCaseFromDataFile(
  dataPath: string,
  caseId: string
): Promise<{ deleted: boolean }> {
  const resolvedPath = resolve(process.cwd(), dataPath);
  if (!existsSync(resolvedPath)) {
    return { deleted: false };
  }
  const data = await loadDataFile(resolvedPath);
  const before = (data.testCases || []).length;
  data.testCases = (data.testCases || []).filter(tc => tc.id !== caseId);
  const deleted = data.testCases.length < before;
  if (deleted) {
    await saveDataFile(resolvedPath, data);
  }
  return { deleted };
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
    // 直接复用从 JSON 加载测试用例的逻辑（包含 apiRecords 等扩展字段）
    const { testCases } = await loadTestCasesFromDataFile(dataPath);
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
  const data: DataFile = existsSync(dataPath) ? await loadDataFile(dataPath) : { sourceFile: '', testCases: [] };

  // 确保 testCases 数组存在
  data.testCases = data.testCases || [];
  const caseById = new Map<string, TestCaseJson>(data.testCases.map(tc => [tc.id, tc]));

  // 1) 先处理请求体，生成 requestSchema，写入到对应用例的 apiRecords[apiUrl].requestSchema
  testCaseRequestMap.forEach((reqMap, testCaseId) => {
    // 若 data 中还没有此用例的壳子，则补一个最小壳，方便后续手动编辑
    if (!caseById.has(testCaseId)) {
      const shell: TestCaseJson = {
        id: testCaseId,
        name: testCaseId,
        url: '',
        steps: [],
        expectedResult: '',
        description: ''
      };
      data.testCases.push(shell);
      caseById.set(testCaseId, shell);
    }
    const tc = caseById.get(testCaseId)!;
    tc.apiRecords = tc.apiRecords || {};

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

      if (!tc.apiRecords![apiUrl]) tc.apiRecords![apiUrl] = {};
      tc.apiRecords![apiUrl].requestSchema = requestSchema;
    });
  });

  // 2) 再写入响应快照到对应用例的 apiRecords[apiUrl].response
  testCaseResponseMap.forEach((resMap, testCaseId) => {
    if (!caseById.has(testCaseId)) {
      const shell: TestCaseJson = {
        id: testCaseId,
        name: testCaseId,
        url: '',
        steps: [],
        expectedResult: '',
        description: ''
      };
      data.testCases.push(shell);
      caseById.set(testCaseId, shell);
    }
    const tc = caseById.get(testCaseId)!;
    tc.apiRecords = tc.apiRecords || {};

    resMap.forEach((res, apiUrl) => {
      if (!tc.apiRecords![apiUrl]) tc.apiRecords![apiUrl] = {};
      tc.apiRecords![apiUrl].response = {
        url: res.url,
        status: res.status,
        headers: res.headers || {},
        body: res.body
      };
    });
  });

  await saveDataFile(dataPath, data);
}
