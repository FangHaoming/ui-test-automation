/**
 * Ollama客户端包装器
 * 使用AI SDK的Ollama集成，为Stagehand提供本地LLM支持
 */


/**
 * 检查Ollama服务是否可用
 * @param baseURL - Ollama服务地址
 * @returns Promise<boolean>
 */
export async function checkOllamaService(baseURL: string = 'http://localhost:11434'): Promise<boolean> {
  try {
    const response = await fetch(`${baseURL}/api/tags`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * 获取Ollama配置
 * 从环境变量读取配置，提供默认值
 */
export function getOllamaConfig(): {
  model: string;
  baseURL: string;
} {
  return {
    model: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  };
}
