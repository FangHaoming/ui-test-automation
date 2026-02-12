import { createOllama } from 'ollama-ai-provider-v2';

// Ollama 聊天接口为 /api/chat，故 baseURL 需包含 /api；优先读 OLLAMA_BASE_URL，其次 LOCAL_LLM_URL
const ollamaBaseUrl =
  process.env.OLLAMA_BASE_URL ||
  process.env.LOCAL_LLM_URL ||
  'http://localhost:11434/api';

export const OllamaProvider = createOllama({
  baseURL: ollamaBaseUrl,
});
