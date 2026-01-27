/**
 * Custom OpenAI Client
 * 用于将 OpenAI 客户端适配到 Stagehand 的 LLMClient 接口
 * 支持代理配置
 * 
 * 参考: https://github.com/browserbase/stagehand/blob/main/packages/core/examples/external_clients/customOpenAI.ts
 */

import OpenAI from 'openai';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import type { ChatCompletion } from 'openai/resources';
import type { CreateChatCompletionOptions } from './aisdkClient.js';

export interface CustomOpenAIClientOptions {
  modelName: string;
  apiKey?: string;
  baseURL?: string;
  proxyUrl?: string;
  disableProxy?: boolean;
  timeout?: number;
}

/**
 * Custom OpenAI Client 包装器
 * 将 OpenAI 客户端适配到 Stagehand 的接口
 */
export class CustomOpenAIClient {
  public type = 'openai' as const;
  public modelName: string;
  private client: OpenAI;

  constructor({
    modelName,
    apiKey,
    baseURL,
    proxyUrl,
    disableProxy = false,
    timeout,
  }: CustomOpenAIClientOptions) {
    this.modelName = modelName;

    // 从环境变量读取配置（如果未提供）
    const finalApiKey = apiKey || process.env.OPENAI_API_KEY;
    const finalBaseURL = baseURL || process.env.OPENAI_BASE_URL || undefined;
    const finalProxyUrl = proxyUrl || process.env.PROXY_URL || undefined;
    const finalDisableProxy = disableProxy || process.env.DISABLE_PROXY === 'true';
    const finalTimeout = timeout || parseInt(process.env.OPENAI_TIMEOUT || '300000');

    if (!finalApiKey) {
      throw new Error('OpenAI API Key 未提供，请设置 OPENAI_API_KEY 环境变量或在构造函数中提供');
    }

    // 配置代理
    let customFetch: any = undiciFetch;
    if (finalProxyUrl && !finalDisableProxy) {
      try {
        const proxyAgent = new ProxyAgent(finalProxyUrl);
        customFetch = (url: any, options: any = {}) => {
          return undiciFetch(url, {
            ...options,
            dispatcher: proxyAgent,
            connectTimeout: 10000,
          });
        };
      } catch (error) {
        console.warn(`⚠️  代理配置失败，将不使用代理: ${error}`);
      }
    }

    // 创建 OpenAI 客户端
    // @ts-ignore - OpenAI 的 fetch 类型与 undici 的 fetch 类型不完全兼容，但运行时是兼容的
    this.client = new OpenAI({
      apiKey: finalApiKey,
      baseURL: finalBaseURL,
      fetch: customFetch,
      timeout: finalTimeout,
      maxRetries: 2,
    });
  }

  async createChatCompletion<T = ChatCompletion>({
    options,
    retries = 3,
  }: CreateChatCompletionOptions & { retries?: number }): Promise<T> {
    const { requestId, ...optionsWithoutImageAndRequestId } = options;

    let responseFormat:
      | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format']
      | undefined;
    if (options.response_model) {
      responseFormat = {
        type: 'json_object',
      };
    }

    // 移除不支持的选项
    const { response_model, ...openaiOptions } = {
      ...optionsWithoutImageAndRequestId,
      model: this.modelName,
    };

    // 格式化消息
    const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      options.messages.map((message) => {
        if (Array.isArray(message.content)) {
          const contentParts = message.content.map((content) => {
            if ('image_url' in content) {
              return {
                image_url: {
                  url: content.image_url?.url,
                },
                type: 'image_url',
              } as OpenAI.Chat.Completions.ChatCompletionContentPartImage;
            } else {
              return {
                text: content.text || '',
                type: 'text',
              } as OpenAI.Chat.Completions.ChatCompletionContentPartText;
            }
          });

          if (message.role === 'system') {
            return {
              ...message,
              role: 'system',
              content: contentParts.filter(
                (content): content is OpenAI.Chat.Completions.ChatCompletionContentPartText =>
                  content.type === 'text',
              ),
            } as OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
          } else if (message.role === 'user') {
            return {
              ...message,
              role: 'user',
              content: contentParts,
            } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
          } else {
            return {
              ...message,
              role: 'assistant',
              content: contentParts.filter(
                (content): content is OpenAI.Chat.Completions.ChatCompletionContentPartText =>
                  content.type === 'text',
              ),
            } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
          }
        }

        return {
          role: message.role,
          content: message.content as string,
        } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
      });

    // 如果有 response_model，添加 schema 提示
    if (options.response_model) {
      const schemaJson = JSON.stringify(
        options.response_model.schema,
        null,
        2,
      );
      formattedMessages.push({
        role: 'user',
        content: `Respond with valid JSON matching this schema:\n${schemaJson}\n\nDo not include any other text, formatting or markdown in your output. Do not include \`\`\` or \`\`\`json in your response. Only the JSON object itself.`,
      });
    }

    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      ...openaiOptions,
      model: this.modelName,
      messages: formattedMessages,
      response_format: responseFormat,
      stream: false,
      tools: options.tools?.map((tool) => ({
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        type: 'function',
      })),
    };

    try {
      const response = await this.client.chat.completions.create(body);

      // 如果有 response_model，解析并验证 JSON
      if (options.response_model) {
        const extractedData = response.choices[0].message.content;
        if (!extractedData) {
          throw new Error('No content in response');
        }

        let parsedData: unknown;
        try {
          parsedData = JSON.parse(extractedData);
          // 这里可以添加 Zod schema 验证
          // validateZodSchema(options.response_model.schema, parsedData);
        } catch (e) {
          const isParseError = e instanceof SyntaxError;
          if (retries > 0) {
            return this.createChatCompletion({
              options,
              retries: retries - 1,
            });
          }

          throw new Error(
            isParseError
              ? 'Failed to parse model response as JSON'
              : e instanceof Error
                ? e.message
                : 'Unknown error during response processing',
          );
        }

        return {
          data: parsedData,
          usage: {
            prompt_tokens: response.usage?.prompt_tokens ?? 0,
            completion_tokens: response.usage?.completion_tokens ?? 0,
            total_tokens: response.usage?.total_tokens ?? 0,
          },
        } as T;
      }

      // 返回完整的 ChatCompletion 对象
      return response as T;
    } catch (error: any) {
      // 如果是可重试的错误，进行重试
      if (retries > 0 && (error?.status === 429 || error?.status >= 500)) {
        return this.createChatCompletion({
          options,
          retries: retries - 1,
        });
      }
      throw error;
    }
  }
}

/**
 * 创建 Custom OpenAI Client
 * 便捷函数，从环境变量读取配置
 */
export function createCustomOpenAIClient(
  options?: Partial<CustomOpenAIClientOptions>,
): CustomOpenAIClient {
  const modelName =
    options?.modelName ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini';

  return new CustomOpenAIClient({
    modelName,
    ...options,
  });
}
