/**
 * 校验 OpenAI API 连接
 * 用于诊断 "Cannot connect to API" 等连接错误
 *
 * 用法: npx tsx scripts/verify-openai-connection.ts
 * 或:   yarn tsx scripts/verify-openai-connection.ts
 */

import 'dotenv/config';
import { createOpenAI } from '@ai-sdk/openai';
import { fetch as undiciFetch, request as undiciRequest, ProxyAgent } from 'undici';
import { generateText } from 'ai';

function maskKey(key: string): string {
  if (!key || key.length < 8) return '(未设置或过短)';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

async function main() {
  console.log('========== OpenAI 连接校验 ==========\n');

  const apiKey = process.env.OPENAI_API_KEY;
  const proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  console.log('环境变量:');
  console.log('  OPENAI_API_KEY:', apiKey ? maskKey(apiKey) : '(未设置)');
  console.log('  OPENAI_MODEL:', model);
  console.log('  OPENAI_BASE_URL:', baseURL || '(未设置，使用默认 api.openai.com)');
  console.log('  PROXY_URL:', proxyUrl || '(未设置)');
  if (model === 'gpt-5') {
    console.log('');
    console.warn('  提示: OPENAI_MODEL=gpt-5 可能无效，当前常用为 gpt-4o / gpt-4o-mini，请到 OpenAI 文档确认模型 ID。');
  }
  console.log('');

  if (!apiKey) {
    console.error('错误: 未设置 OPENAI_API_KEY，请在 .env 中配置');
    process.exit(1);
  }
  if (!apiKey.startsWith('sk-') && apiKey !== 'local-llm-key') {
    console.warn('警告: OPENAI_API_KEY 通常以 sk- 开头，请确认 Key 是否正确');
  }

  // 1. 若配置了代理，先检查代理是否可达
  if (proxyUrl) {
    console.log('检查代理可达性...');
    try {
      const u = new URL(proxyUrl);
      const proxyHost = u.hostname;
      const proxyPort = parseInt(u.port || '80', 10);
      const net = await import('net');
      const proxyReachable = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const t = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 5000);
        socket.connect(proxyPort, proxyHost, () => {
          clearTimeout(t);
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          clearTimeout(t);
          resolve(false);
        });
      });
      if (proxyReachable) {
        console.log('  代理可达:', proxyUrl);
      } else {
        console.warn('  代理不可达:', proxyUrl);
        console.warn('  请确认代理软件已启动（如 Clash/V2Ray 等），且端口与 PROXY_URL 一致');
      }
    } catch (e: any) {
      console.warn('  解析/检测代理失败:', e.message);
    }
    console.log('');
  }

  // 2. 若使用代理，先用 undici.request 直连一次以拿到底层错误（fetch 层会吞掉 cause）
  let rawRequestStatus: number | null = null;
  const disableProxy = process.env.DISABLE_PROXY === 'true' || process.env.DISABLE_PROXY === '1';
  if (proxyUrl && !disableProxy) {
    console.log('经代理直连测试（抓取底层错误）...');
    try {
      const proxyAgent = new ProxyAgent(proxyUrl);
      const apiUrl = baseURL ? new URL('/v1/models', baseURL).href : 'https://api.openai.com/v1/models';
      const res = await undiciRequest(apiUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        dispatcher: proxyAgent,
        connectTimeout: 15000,
      });
      rawRequestStatus = res.statusCode;
      console.log('  经代理直连成功，状态:', res.statusCode);
      if (res.statusCode === 401) {
        console.warn('  → 401 未授权：API Key 无效或已过期，请到 https://platform.openai.com 检查并更换 Key。');
        console.warn('  （后续 generateText 可能被误报为 "Cannot connect to API"，实际是 Key 问题。）');
      }
    } catch (rawErr: any) {
      console.error('  经代理直连失败（底层错误）:');
      console.error('    name:', rawErr?.name);
      console.error('    message:', rawErr?.message);
      console.error('    code:', (rawErr as any)?.code);
      if ((rawErr as any)?.cause) {
        const c = (rawErr as any).cause;
        console.error('    cause.message:', c?.message);
        console.error('    cause.code:', c?.code);
      }
      console.error('    stack:', rawErr?.stack?.split('\n').slice(0, 4).join('\n'));
      console.log('');
    }
  }

  // 3. 使用与 openai-provider 相同的 fetch（含代理）
  let customFetch: any = undiciFetch;
  if (proxyUrl && !disableProxy) {
    try {
      const proxyAgent = new ProxyAgent(proxyUrl);
      customFetch = (url: any, options: any = {}) => {
        return undiciFetch(url, {
          ...options,
          dispatcher: proxyAgent,
          connectTimeout: 15000,
        });
      };
    } catch (e: any) {
      console.warn('代理 Agent 创建失败，将直连:', e.message);
    }
  }

  const openai = createOpenAI({
    apiKey,
    baseURL: baseURL || undefined,
    fetch: customFetch,
  });

  console.log('正在请求 OpenAI API（单次简单生成）...');
  try {
    const result = await generateText({
      model: openai(model),
      prompt: 'Reply with exactly: OK',
      maxRetries: 0,
    });
    console.log('结果:', result.text?.trim() || '(空)');
    console.log('\n✓ 连接成功，API Key 有效');
  } catch (err: any) {
    console.error('\n✗ 请求失败');
    console.error('  错误类型:', err?.name || err?.constructor?.name);
    console.error('  错误信息:', err?.message);

    const cause = err?.cause;
    if (cause) {
      console.error('  底层原因 (cause):');
      console.error('    message:', cause?.message);
      console.error('    code:', (cause as any)?.code);
      // 打印完整 cause 便于诊断（如 undici 的 network error）
      try {
        const keys = Object.keys(cause as object).filter((k) => !/^stack$/i.test(k));
        if (keys.length) console.error('    keys:', keys.join(', '));
      } catch (_) {}
      if (cause?.stack) {
        console.error('    stack:', cause.stack.split('\n').slice(0, 5).join('\n'));
      }
    }

    // 常见错误提示
    const code = (cause as any)?.code;
    if (code === 'ECONNREFUSED') {
      console.error('\n  → 连接被拒绝：目标地址/端口无服务。若使用代理，请确认代理已启动且 PROXY_URL 正确。');
    } else if (code === 'ENOTFOUND') {
      console.error('\n  → DNS 解析失败：无法解析 API 域名。若在国内，请确保代理已开启并支持 HTTPS。');
    } else if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
      console.error('\n  → 连接超时或重置：网络不稳定或被墙，请检查代理或网络。');
    } else if (err?.message?.includes('401') || (cause as any)?.status === 401) {
      console.error('\n  → 401 未授权：API Key 无效或已过期，请到 OpenAI 后台检查并更换。');
    } else if (rawRequestStatus === 401) {
      console.error('\n  → 经代理直连已返回 401：实际是 API Key 无效或已过期，不是网络问题。');
      console.error('    请到 https://platform.openai.com/api-keys 检查并更换 OPENAI_API_KEY。');
    } else if (!(cause as any)?.code && !(cause as any)?.message && err?.message?.includes('Cannot connect to API')) {
      console.error('\n  → 底层错误信息被吞掉，若上面「经代理直连测试」返回 401，请按 401 处理（更换 Key）。');
    }

    // 若配置了代理且失败，提示可尝试关闭代理或检查代理 HTTPS
    if (proxyUrl) {
      console.error('\n  若你在国内需代理访问，请确认:');
      console.error('    1. 代理软件已开启「允许来自局域网的连接」');
      console.error('    2. PROXY_URL 端口与代理软件一致（当前:', proxyUrl, '）');
      console.error('  可临时关闭代理重试: DISABLE_PROXY=1 npx tsx scripts/verify-openai-connection.ts');
    }

    process.exit(1);
  }
}

main();
