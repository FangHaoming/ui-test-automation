import type { Stagehand } from '@browserbasehq/stagehand';
import type { AISdkClient } from './aisdkClient.js';

/** URL 断言：用 page.url() 校验，observe 无法“观察”URL */
export interface UrlAssertion {
  type: 'url';
  value: string;
}

/** 其他断言：自然语言描述，交给 stagehand.observe(prompt) */
export type ObserveAssertion = string;

export type AssertionItem = UrlAssertion | ObserveAssertion;

export interface AssertionPlan {
  summary: string;
  /** URL 断言用 page 校验，字符串用 stagehand.observe 校验 */
  assertions: AssertionItem[];
}

/**
 * 使用 AI 生成基于 stagehand.observe 的断言计划（自然语言 observe 描述列表）
 */
async function planAssertionsWithAI(
  expectedResult: string,
  stagehand: Stagehand,
  llmClient: AISdkClient | null
): Promise<AssertionPlan> {
  // 未配置 LLM 时，直接用预期结果作为单条 observe 断言
  if (!llmClient) {
    return {
      summary: '未配置 LLM，使用预期结果作为 observe 描述',
      assertions: [expectedResult]
    };
  }

  const { z } = await import('zod');
  const UrlAssertionSchema = z.object({ type: z.literal('url'), value: z.string() });
  const AssertionItemSchema = z.union([z.string(), UrlAssertionSchema]);
  const AssertionPlanSchema = z.object({
    summary: z.string(),
    assertions: z.array(AssertionItemSchema).min(1)
  });

  const response = await llmClient.createChatCompletion({
    options: {
      messages: [
        {
          role: 'system',
          content:
            '你是一名资深前端测试工程师。请根据“预期结果描述”生成断言列表。\n\n' +
            '【输出要求】\n' +
            '1. 只返回一个 JSON 对象，不要返回任何解释、Markdown 代码块或多余文本。\n' +
            '2. 结构必须为：\n' +
            '{\n' +
            '  "summary": "一句话总结本次断言",\n' +
            '  "assertions": [ 项1, 项2, ... ]\n' +
            '}\n\n' +
            '【assertions 项类型】\n' +
            '（1）**跳转/URL 类**：必须用对象，不要用 observe 描述。stagehand.observe 无法检测 URL。\n' +
            '  {"type": "url", "value": "要包含的 URL 片段"}  // 如 "task-pre.renderbus.com" 或 "/dashboard"\n' +
            '（2）**元素/文案类**：用英文短句，会传给 stagehand.observe(prompt)。\n' +
            '  "find the submit button", "find the text \'支付成功\'", "find the link to dashboard"\n' +
            '当预期包含「跳转到」「进入某页面」「URL 为」「打开某链接」等时，至少有一条 type 为 "url" 的断言；其余用 observe 英文描述。保证输出为合法 JSON。'
        },
        {
          role: 'user',
          content: `预期结果（用户写在 Excel 中）:\n${expectedResult}`
        }
      ],
    }
  });

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
 * 执行断言：URL 用 page.url() 校验，其余用 stagehand.observe
 */
async function runAssertionPlan(
  plan: AssertionPlan,
  stagehand: Stagehand,
  page: any
): Promise<string> {
  const logs: string[] = [];
  logs.push(`断言计划: ${plan.summary}`);

  for (const [idx, item] of plan.assertions.entries()) {
    if (typeof item === 'object' && item !== null && item.type === 'url') {
      const value = item.value;
      const url = await page.url();
      if (!url.includes(value)) {
        const msg = `URL 不包含 "${value}"，当前: ${url}`;
        logs.push(`[#${idx + 1}] ✗ ${msg}`);
        throw new Error(`断言 #${idx + 1} 未通过: ${msg}`);
      }
      logs.push(`[#${idx + 1}] ✓ URL 包含: ${value}`);
    } else {
      const observePrompt = typeof item === 'string' ? item : String(item);
      const actions = await stagehand.observe(observePrompt);
      if (actions.length === 0) {
        const msg = `未找到「${observePrompt}」`;
        logs.push(`[#${idx + 1}] ✗ ${msg}`);
        throw new Error(`断言 #${idx + 1} 未通过: ${msg}`);
      }
      logs.push(`[#${idx + 1}] ✓ ${observePrompt}`);
    }
  }

  return logs.join('\n');
}

/**
 * 对外暴露的统一入口：使用 AI + Stagehand.observe 校验预期结果
 * - 如果提供 existingPlan，则直接复用计划，不再调用 LLM 生成
 * - 返回日志和实际使用的断言计划，便于持久化到 result 下复用
 */
export async function verifyExpectedResultWithAI(params: {
  expectedResult: string;
  stagehand: Stagehand;
  page: any;
  llmClient: AISdkClient | null;
  existingPlan?: AssertionPlan | null;
}): Promise<{ log: string; plan: AssertionPlan }> {
  const { expectedResult, stagehand, page, llmClient, existingPlan } = params;

  // 1. 生成或复用断言计划
  const plan =
    existingPlan && existingPlan.assertions?.length
      ? existingPlan
      : await planAssertionsWithAI(expectedResult, stagehand, llmClient);

  // 2. 执行断言（URL 用 page.url()，其余用 stagehand.observe）
  const assertionLog = await runAssertionPlan(plan, stagehand, page);

  const log = ['断言执行结果：', assertionLog].join('\n').trim();
  return { log, plan };
}
