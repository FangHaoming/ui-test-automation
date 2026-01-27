/**
 * AI SDK Client 包装器
 * 用于将 AI SDK 的 LanguageModel 适配到 Stagehand 的 LLMClient 接口
 * 
 * 参考: https://github.com/browserbase/stagehand/blob/v2/examples/external_clients/aisdk.ts
 */

import {
  SystemModelMessage,
  UserModelMessage,
  AssistantModelMessage,
  ModelMessage,
  generateObject,
  generateText,
  ImagePart,
  LanguageModel,
  TextPart,
  ToolSet,
  type TypedToolCall,
} from 'ai';
import type { ChatCompletion } from 'openai/resources';

/**
 * Stagehand 期望的 LLM 客户端接口
 */
export interface CreateChatCompletionOptions {
  options: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | Array<{
        type: 'text' | 'image_url';
        text?: string;
        image_url?: { url: string };
      }>;
    }>;
    response_model?: {
      schema: any;
    };
    tools?: Array<{
      name: string;
      description: string;
      parameters: any;
    }>;
    tool_choice?: 'auto' | 'required' | 'none';
    requestId?: string;
  };
}

/**
 * AI SDK Client 包装器
 * 将 AI SDK 的 LanguageModel 适配到 Stagehand 的接口
 */
export class AISdkClient {
  private model: LanguageModel;
  public modelName: string;

  constructor({ model }: { model: LanguageModel }) {
    this.model = model;
    // Stagehand 期望有 modelName 属性（必需！）
    // 从模型对象中提取 modelId，确保始终是字符串
    const modelAny = model as any;
    let modelId = 'ollama-model';
    
    if (modelAny?.modelId) {
      modelId = String(modelAny.modelId);
    } else if (typeof model === 'string') {
      modelId = model;
    } else if (modelAny?.id) {
      modelId = String(modelAny.id);
    }
    
    // 确保 modelName 始终是字符串，不能是 undefined
    this.modelName = modelId || 'ollama-model';
    
    // 验证 modelName 不是 undefined
    if (!this.modelName || typeof this.modelName !== 'string') {
      throw new Error(`无法确定模型名称: ${JSON.stringify({ modelId, modelType: typeof model })}`);
    }
  }

  public getLanguageModel(): LanguageModel {
    return this.model;
  }

  async createChatCompletion<T = ChatCompletion>({
    options,
  }: CreateChatCompletionOptions): Promise<T> {
    // 格式化消息为 AI SDK 格式
    const formattedMessages: ModelMessage[] = options.messages.map((message) => {
      if (Array.isArray(message.content)) {
        if (message.role === 'system') {
          const systemMessage: SystemModelMessage = {
            role: 'system',
            content: message.content
              .map((c) => ('text' in c ? c.text : ''))
              .join('\n'),
          };
          return systemMessage;
        }

        const contentParts = message.content.map((content) => {
          if ('image_url' in content && content.image_url) {
            const imageContent: ImagePart = {
              type: 'image',
              image: content.image_url.url,
            };
            return imageContent;
          } else {
            const textContent: TextPart = {
              type: 'text',
              text: ('text' in content ? content.text : '') || '',
            };
            return textContent;
          }
        });

        if (message.role === 'user') {
          const userMessage: UserModelMessage = {
            role: 'user',
            content: contentParts,
          };
          return userMessage;
        } else {
          const textOnlyParts = contentParts.map((part) => ({
            type: 'text' as const,
            text: part.type === 'image' ? '[Image]' : part.text,
          }));
          const assistantMessage: AssistantModelMessage = {
            role: 'assistant',
            content: textOnlyParts,
          };
          return assistantMessage;
        }
      }

      return {
        role: message.role,
        content: message.content as string,
      } as ModelMessage;
    });

    // 如果有 response_model，使用 generateObject
    if (options.response_model) {
      try {
        const objectResponse = await generateObject({
          model: this.model,
          messages: formattedMessages,
          schema: options.response_model.schema,
        });

        // 安全地提取对象和 usage 信息
        const result = {
          data: objectResponse.object || {},
          usage: {
            prompt_tokens: (objectResponse.usage as any)?.promptTokens ?? 0,
            completion_tokens: (objectResponse.usage as any)?.completionTokens ?? 0,
            total_tokens: (objectResponse.usage as any)?.totalTokens ?? 0,
          },
        } as T;

        return result;
      } catch (err: any) {
        throw err;
      }
    }

    // 处理工具调用
    const tools: ToolSet = {};
    if (options.tools && options.tools.length > 0) {
      const { tool } = await import('ai');
      for (const toolDef of options.tools) {
        // 使用 tool() 函数创建工具定义
        tools[toolDef.name] = tool({
          description: toolDef.description,
          parameters: toolDef.parameters,
          execute: async () => ({}), // 占位执行函数
        } as any);
      }
    }

    // 使用 generateText
    const textResponse = await generateText({
      model: this.model,
      messages: formattedMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      toolChoice:
        Object.keys(tools).length > 0
          ? options.tool_choice === 'required'
            ? 'required'
            : options.tool_choice === 'none'
              ? 'none'
              : 'auto'
          : undefined,
    });

    // 转换工具调用格式，确保所有字段都是安全的
    const transformedToolCalls = (textResponse.toolCalls || []).map(
      (toolCall: TypedToolCall<any>) => {
        const toolCallAny = toolCall as any;
        const toolName = toolCallAny.toolName || toolCallAny.toolCallName || 'unknown';
        const toolArgs = toolCallAny.args || toolCallAny.input || {};
        
        // 确保 arguments 是有效的 JSON 字符串
        let argsString = '{}';
        try {
          argsString = JSON.stringify(toolArgs);
        } catch {
          argsString = '{}';
        }
        
        return {
          id: String(
            toolCallAny.toolCallId ||
            `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          ),
          type: 'function' as const,
          function: {
            name: String(toolName),
            arguments: argsString,
          },
        };
      },
    );

    // 安全地提取 finishReason，确保始终是字符串
    const finishReason = textResponse.finishReason 
      ? String(textResponse.finishReason)
      : (textResponse.text ? 'stop' : 'length');
    
    // 安全地提取模型ID
    const modelId = (this.model as any)?.modelId 
      ? String((this.model as any).modelId)
      : 'ollama-model';
    
    // 安全地提取文本内容
    const content = textResponse.text 
      ? String(textResponse.text)
      : null;
    
    const result = {
      id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: content,
            // 只有当有工具调用时才包含 tool_calls 字段
            ...(transformedToolCalls.length > 0 ? { tool_calls: transformedToolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: (textResponse.usage as any)?.promptTokens ?? 0,
        completion_tokens: (textResponse.usage as any)?.completionTokens ?? 0,
        total_tokens: (textResponse.usage as any)?.totalTokens ?? 0,
      },
    } as T;

    return result;
  }
}
