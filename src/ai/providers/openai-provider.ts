import { createOpenAI } from '@ai-sdk/openai';
import { fetch as undiciFetch, ProxyAgent, EnvHttpProxyAgent } from 'undici';

// 参考 CustomOpenAIClient 中的代理配置，实现带代理的 fetch
let customFetch: any = undiciFetch;

const finalProxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const finalDisableProxy = process.env.DISABLE_PROXY === 'true' || process.env.DISABLE_PROXY === '1';

if (finalProxyUrl && !finalDisableProxy) {
  try {
    // 优先使用 EnvHttpProxyAgent（读 HTTPS_PROXY/HTTP_PROXY），对部分环境兼容更好
    const useEnvProxy = !process.env.PROXY_URL && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
    const dispatcher = useEnvProxy
      ? new EnvHttpProxyAgent({ connectTimeout: 15000 })
      : new ProxyAgent({ uri: finalProxyUrl, connectTimeout: 15000 });
    customFetch = (url: any, options: any = {}) => {
      return undiciFetch(url, {
        ...options,
        // 确保始终使用我们的代理，不被 SDK 传入的 options 覆盖
        dispatcher,
        connectTimeout: options.connectTimeout ?? 15000,
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
