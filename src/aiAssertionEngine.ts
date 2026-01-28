import type { Stagehand } from '@browserbasehq/stagehand';
import type { AISdkClient } from './aisdkClient';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * AI 生成的断言类型
 */
export type AssertionType =
  | 'url_contains'
  | 'url_equals'
  | 'text_visible'
  | 'text_not_visible'
  | 'locator_visible'
  | 'locator_has_text'
  | 'title_contains';

export interface AssertionPlanItem {
  type: AssertionType;
  description: string;
  locator?: string;
  text?: string;
  expected?: string;
}

export interface AssertionPlan {
  summary: string;
  assertions: AssertionPlanItem[];
}

/**
 * 使用 AI 生成 Playwright 断言计划
 */
async function planAssertionsWithAI(
  expectedResult: string,
  stagehand: Stagehand,
  llmClient: AISdkClient | null
): Promise<AssertionPlan> {
  // 先用 Stagehand.observe 获取当前页面的自然语言描述，作为上下文
  let observationText = '';
  try {
    const observations = await stagehand.observe(
      `简要描述当前页面中与以下预期相关的关键元素、文本和状态: ${expectedResult}`
    );
    observationText = observations.map(a => a.description).join('\n') || '无明显观察';
  } catch (error: any) {
    observationText = `无法获取页面观察信息: ${error?.message || String(error)}`;
  }

  // 如果没有可用的 LLM 客户端，则回退为最基础的文本可见性断言计划
  if (!llmClient) {
    return {
      summary: '未配置自定义 LLM 客户端，回退为简单文本可见性检查',
      assertions: [
        {
          type: 'text_visible',
          description: '检查预期结果文本是否出现在页面中',
          text: expectedResult
        }
      ]
    };
  }

  // 使用 Zod 定义结构化断言计划的 schema，用于在本地校验 AI 返回的 JSON
  const { z } = await import('zod');
  const AssertionPlanSchema = z.object({
    summary: z.string(),
    assertions: z.array(
      z.object({
        type: z.enum([
          'url_contains',
          'url_equals',
          'text_visible',
          'text_not_visible',
          'locator_visible',
          'locator_has_text',
          'title_contains'
        ]),
        description: z.string(),
        locator: z.string().optional(),
        text: z.string().optional(),
        expected: z.string().optional()
      })
    ).min(1)
  });

  const response = await llmClient.createChatCompletion({
    options: {
      messages: [
        {
          role: 'system',
          content:
            '你是一名资深前端测试工程师。请根据“预期结果描述”和“当前页面观察信息”，生成一组适合使用 Playwright 实现的断言计划。\n\n' +
            '【输出要求（非常重要，必须严格遵守）】\n' +
            '1. 只返回一个 JSON 对象，不要返回任何解释、Markdown 代码块或多余文本。\n' +
            '2. JSON 结构必须为：\n' +
            '{\n' +
            '  "summary": string,\n' +
            '  "assertions": [\n' +
            '    {\n' +
            '      "type": "url_contains" | "url_equals" | "text_visible" | "text_not_visible" | "locator_visible" | "locator_has_text" | "title_contains",\n' +
            '      "description": string,\n' +
            '      "locator"?: string,\n' +
            '      "text"?: string,\n' +
            '      "expected"?: string\n' +
            '    }\n' +
            '  ]\n' +
            '}\n' +
            '3. 至少生成 1 条 assertion。\n' +
            '4. 保证生成的 JSON 可以被严格解析为上述结构。'
        },
        {
          role: 'user',
          content:
            `预期结果（用户写在 Excel 中）:\n${expectedResult}\n\n` +
            `当前页面观察信息（由 Stagehand.observe 提供）:\n${observationText}`
        }
      ],
    }
  });

  // 从 OpenAI 风格的响应中取出文本内容
  const rawContent =
    (response as any)?.choices?.[0]?.message?.content ??
    (response as any)?.choices?.[0]?.message?.content?.toString?.() ??
    '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(rawContent));
  } catch (e: any) {
    throw new Error(
      `AI 返回的不是合法 JSON，无法解析断言计划。原始内容: ${String(rawContent).slice(0, 500)}`
    );
  }

  const result = AssertionPlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `AI 返回的 JSON 不符合断言计划 schema: ${result.error.message}`
    );
  }

  return result.data;
}

/**
 * 执行 AI 生成的断言计划（使用 Page/Locator 原生 API，避免 @playwright/test 的 expect 依赖 page.context）
 */
async function runAssertionPlan(
  plan: AssertionPlan,
  page: any
): Promise<string> {
  const logs: string[] = [];
  logs.push(`AI 断言计划: ${plan.summary}`);
  const timeout = DEFAULT_TIMEOUT_MS;

  for (const [idx, a] of plan.assertions.entries()) {
    try {
      logs.push(`[#${idx + 1}] ${a.description}`);

      switch (a.type) {
        case 'url_contains': {
          const expected = a.expected ?? '';
          const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const url = await page.url();
          if (!new RegExp(escaped).test(url)) {
            throw new Error(`URL 不包含 "${expected}"，当前: ${url}`);
          }
          logs.push(`  ✓ URL 包含: ${expected}`);
          break;
        }
        case 'url_equals': {
          const expected = a.expected ?? '';
          const url = await page.url();
          if (url !== expected) {
            throw new Error(`URL 不等于 "${expected}"，当前: ${url}`);
          }
          logs.push(`  ✓ URL 等于: ${expected}`);
          break;
        }
        case 'title_contains': {
          const expected = a.expected ?? '';
          const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const title = await page.title();
          if (!new RegExp(escaped).test(title)) {
            throw new Error(`标题不包含 "${expected}"，当前: ${title}`);
          }
          logs.push(`  ✓ 标题包含: ${expected}`);
          break;
        }
        case 'text_visible': {
          const text = a.text ?? a.expected ?? '';
          await page.getByText(text, { exact: false }).waitFor({ state: 'visible', timeout });
          logs.push(`  ✓ 文本可见: ${text}`);
          break;
        }
        case 'text_not_visible': {
          const text = a.text ?? a.expected ?? '';
          await page.getByText(text, { exact: false }).waitFor({ state: 'hidden', timeout });
          logs.push(`  ✓ 文本不可见: ${text}`);
          break;
        }
        case 'locator_visible': {
          const selector = a.locator ?? '';
          await page.locator(selector).waitFor({ state: 'visible', timeout });
          logs.push(`  ✓ 定位器可见: ${selector}`);
          break;
        }
        case 'locator_has_text': {
          const selector = a.locator ?? '';
          const text = a.text ?? a.expected ?? '';
          const loc = page.locator(selector);
          await loc.waitFor({ state: 'visible', timeout });
          const content = await loc.textContent();
          if (content === null || !content.includes(text)) {
            throw new Error(`定位器 "${selector}" 文本不包含 "${text}"，实际: ${content ?? '(空)'}`);
          }
          logs.push(`  ✓ 定位器文本匹配: ${selector} -> ${text}`);
          break;
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      logs.push(`  ✗ 断言失败: ${msg}`);
      throw new Error(`AI 断言 #${idx + 1} 失败: ${msg}`);
    }
  }

  return logs.join('\n');
}

/**
 * 对外暴露的统一入口：使用 AI + Stagehand + Playwright 校验预期结果
 */
export async function verifyExpectedResultWithAI(params: {
  expectedResult: string;
  stagehand: Stagehand;
  page: any;
  llmClient: AISdkClient | null;
}): Promise<string> {
  const { expectedResult, stagehand, page, llmClient } = params;

  // 1. 让 AI 基于预期结果和页面观察信息，规划出一组 Playwright 断言
  const plan = await planAssertionsWithAI(expectedResult, stagehand, llmClient);

  // 2. 执行断言计划（真正跑 Playwright expect）
  const assertionLog = await runAssertionPlan(plan, page);

  // 3. 再用 Stagehand.observe 生成一段总结性描述，方便在报告中查看
  let observationText = '';
  try {
    const observations = await stagehand.observe(
      `描述当前页面状态，尤其是与以下预期相关的内容: ${expectedResult}`
    );
    observationText = observations.map(a => a.description).join('; ') || '无法观察结果';
  } catch (obsError: any) {
    observationText = `结果观察时出错: ${obsError?.message || String(obsError)}`;
  }

  // 4. 可选：尝试提取页面整体文本片段
  let pageSnippet = '';
  try {
    const pageText = await stagehand.extract() as { pageText?: string };
    if (pageText.pageText) {
      pageSnippet = `\n页面内容片段: ${pageText.pageText.substring(0, 200)}`;
    }
  } catch {
    // 忽略 extract 失败
  }

  return [
    'AI 生成的 Playwright 断言执行结果：',
    assertionLog,
    '',
    'Stagehand 观察总结：',
    observationText,
    pageSnippet
  ].join('\n').trim();
}

