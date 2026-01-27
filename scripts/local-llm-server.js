#!/usr/bin/env node

/**
 * 本地LLM服务代理
 * 将Ollama API转换为OpenAI兼容的API格式
 * 这样Stagehand就可以使用本地LLM了
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const PORT = process.env.LOCAL_LLM_PORT || 3001;

/**
 * 将OpenAI格式的请求转换为Ollama格式
 */
function convertToOllamaFormat(openaiRequest) {
  const { messages, model, temperature, max_tokens, stream } = openaiRequest;
  
  // 将消息转换为提示词
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      prompt += `System: ${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${msg.content}\n\n`;
    }
  }
  prompt += 'Assistant:';
  
  return {
    model: OLLAMA_MODEL,
    prompt: prompt,
    stream: stream || false,
    options: {
      temperature: temperature || 0.7,
      num_predict: max_tokens || 2048,
    }
  };
}

/**
 * 将Ollama响应转换为OpenAI格式
 */
function convertToOpenAIFormat(ollamaResponse, stream = false) {
  if (stream) {
    // 流式响应需要特殊处理
    return ollamaResponse;
  }
  
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: OLLAMA_MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: ollamaResponse.response || ''
      },
      finish_reason: ollamaResponse.done ? 'stop' : 'length'
    }],
    usage: {
      prompt_tokens: ollamaResponse.prompt_eval_count || 0,
      completion_tokens: ollamaResponse.eval_count || 0,
      total_tokens: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
    }
  };
}

/**
 * 代理请求到Ollama
 */
function proxyToOllama(path, method, body, headers, res) {
  const url = new URL(`${OLLAMA_BASE_URL}${path}`);
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };
  
  const httpModule = url.protocol === 'https:' ? https : http;
  
  const req = httpModule.request(options, (ollamaRes) => {
    res.writeHead(ollamaRes.statusCode, ollamaRes.headers);
    ollamaRes.pipe(res);
  });
  
  req.on('error', (error) => {
    console.error('Ollama请求错误:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '无法连接到Ollama服务', type: 'server_error' } }));
  });
  
  if (body) {
    req.write(JSON.stringify(body));
  }
  
  req.end();
}

/**
 * 处理OpenAI兼容的聊天完成请求
 */
function handleChatCompletion(req, res, body) {
  try {
    const openaiRequest = JSON.parse(body);
    const ollamaRequest = convertToOllamaFormat(openaiRequest);
    
    // 调用Ollama API
    const url = new URL(`${OLLAMA_BASE_URL}/api/generate`);
    const httpModule = url.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const ollamaReq = httpModule.request(options, (ollamaRes) => {
      let ollamaData = '';
      
      ollamaRes.on('data', (chunk) => {
        ollamaData += chunk.toString();
      });
      
      ollamaRes.on('end', () => {
        try {
          const ollamaResponse = JSON.parse(ollamaData);
          const openaiResponse = convertToOpenAIFormat(ollamaResponse, openaiRequest.stream);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(openaiResponse));
        } catch (error) {
          console.error('解析Ollama响应错误:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '解析响应失败', type: 'server_error' } }));
        }
      });
    });
    
    ollamaReq.on('error', (error) => {
      console.error('Ollama请求错误:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: { 
          message: `无法连接到Ollama服务 (${OLLAMA_BASE_URL})，请确保Ollama正在运行`, 
          type: 'server_error' 
        } 
      }));
    });
    
    ollamaReq.write(JSON.stringify(ollamaRequest));
    ollamaReq.end();
    
  } catch (error) {
    console.error('处理请求错误:', error);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, type: 'invalid_request_error' } }));
  }
}

/**
 * 创建HTTP服务器
 */
const server = http.createServer((req, res) => {
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  let body = '';
  
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // OpenAI兼容的聊天完成端点
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      handleChatCompletion(req, res, body);
    }
    // 健康检查端点
    else if (url.pathname === '/health' && req.method === 'GET') {
      // 检查Ollama是否可用
      const ollamaUrl = new URL(`${OLLAMA_BASE_URL}/api/tags`);
      const httpModule = ollamaUrl.protocol === 'https:' ? https : http;
      
      const checkReq = httpModule.get(ollamaUrl, (checkRes) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'ok', 
          ollama: 'connected',
          model: OLLAMA_MODEL,
          base_url: OLLAMA_BASE_URL
        }));
      });
      
      checkReq.on('error', () => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'error', 
          ollama: 'disconnected',
          message: `无法连接到Ollama服务 (${OLLAMA_BASE_URL})`
        }));
      });
    }
    // 其他请求直接代理到Ollama
    else {
      proxyToOllama(req.url, req.method, body ? JSON.parse(body) : null, req.headers, res);
    }
  });
});

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('本地LLM服务代理已启动');
  console.log('==========================================');
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`Ollama地址: ${OLLAMA_BASE_URL}`);
  console.log(`使用模型: ${OLLAMA_MODEL}`);
  console.log('');
  console.log('OpenAI兼容端点:');
  console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('按 Ctrl+C 停止服务');
  console.log('==========================================');
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  server.close(() => {
    console.log('服务已关闭');
    process.exit(0);
  });
});
