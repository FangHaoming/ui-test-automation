import { createOpenAI } from '@ai-sdk/openai';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

// 参考 CustomOpenAIClient 中的代理配置，实现带代理的 fetch
let customFetch: any = undiciFetch;

const finalProxyUrl = process.env.PROXY_URL || undefined;
const finalDisableProxy = process.env.DISABLE_PROXY === 'true';

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
    console.warn(`⚠️  OpenAI Provider 代理配置失败，将不使用代理: ${error}`);
  }
}

export const OpenaiProvider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  // 使用与 CustomOpenAIClient 相同逻辑构造的 fetch（支持代理）
  fetch: customFetch,
});
