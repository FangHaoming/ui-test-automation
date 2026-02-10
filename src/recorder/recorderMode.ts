/**
 * 记录模式 - 允许用户手动操作浏览器并自动记录操作和网络请求
 */

import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';
import { ActionRecorder, type RecordedAction } from './actionRecorder.js';
import { NetworkInterceptor, type ApiEndpoint, type NetworkResponse, type NetworkRequest } from '../utils/networkInterceptor.js';
import { parseApiEndpoints } from '../data/excelParser.js';
import { ensureDataFileFromExcel, saveApiRecords } from '../data/dataStore.js';
import { ensurePlaywrightBrowsersInstalled } from '../utils/browserChecker.js';
import { generateZodSchemaCode } from '../utils/zodSchemaGenerator.js';
import { OllamaProvider } from '../ai/providers/ollama-provider.js';
import chalk from 'chalk';
import { writeFile } from 'fs/promises';
import { OpenaiProvider } from '../ai/providers/openai-provider.js';
import { AISdkClient } from '../ai/aisdkClient.js';

export interface RecorderOptions {
  url?: string;
  excelFile?: string; // 用于读取API endpoint配置
  outputFile?: string; // 输出记录的文件路径
  headless?: boolean;
  debug?: boolean;
}

export class RecorderMode {
  private stagehand: Stagehand | null = null;
  private page: any = null;
  private actionRecorder: ActionRecorder | null = null;
  private networkInterceptor: NetworkInterceptor | null = null;
  private options: Required<RecorderOptions>;
  private apiEndpoints: ApiEndpoint[] = [];
  /** 对应 data 目录下的 JSON 路径（当提供了 excelFile 时） */
  private dataPath: string = '';

  constructor(options: RecorderOptions = {}) {
    this.options = {
      url: options.url || '',
      excelFile: options.excelFile || '',
      outputFile: options.outputFile || './recorded-actions.json',
      headless: options.headless !== false,
      debug: options.debug || false,
      ...options
    } as Required<RecorderOptions>;
  }

  /**
   * 初始化记录器
   */
  async init(): Promise<void> {
    // 确保 Playwright 浏览器已安装
    await ensurePlaywrightBrowsersInstalled();
    
    console.log(chalk.cyan('正在初始化记录模式...'));
    
    // 检查是否使用本地LLM
    const useLocalLLM = process.env.USE_LOCAL_LLM === 'true';
    
    // 确定使用的模型提供商
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    // 构建Stagehand配置
    const stagehandConfig: any = {
      env: 'LOCAL',
      verbose: this.options.debug ? 2 : 0,
      localBrowserLaunchOptions: {
        headless: this.options.headless
      },
      // 不等待 iframe 加载完成，避免被验证码等第三方 iframe 卡住超时
      domSettleTimeout: 0,
    };
    
    // 如果使用本地LLM，使用AI SDK的Ollama集成
    if (useLocalLLM) {
      try {
        // Stagehand v3 支持通过 llmClient 参数传入自定义LLM客户端
        stagehandConfig.llmClient = new AISdkClient({
          model: OllamaProvider.languageModel(process.env.OLLAMA_MODEL || 'qwen2.5:3b'),
        });
        console.log(chalk.cyan('✓ 已配置Ollama本地LLM客户端'));
      } catch (error: any) {
        console.error(chalk.red('\n✗ Ollama客户端初始化失败:'));
        console.error(chalk.red(error.message));
        console.error(chalk.yellow('\n请确保:'));
        console.error(chalk.yellow('  1. Ollama服务正在运行: ollama serve'));
        console.error(chalk.yellow('  2. 已下载模型: ollama pull qwen2.5:3b'));
        console.error(chalk.yellow('  3. 检查 .env 文件中的 OLLAMA_BASE_URL 和 OLLAMA_MODEL 配置'));
        throw error;
      }
    }
    // Stagehand v3 会自动从环境变量检测 API Key 和模型
    // 模型名称可以从环境变量读取，如果没有设置则使用默认值
    else if (hasAnthropic && !hasOpenAI && !hasGoogle) {
      // 只配置了 Anthropic，从环境变量读取模型名称，如果没有则使用默认值
      const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      stagehandConfig.model = anthropicModel;
      console.log(chalk.cyan(`使用 Anthropic 模型: ${anthropicModel}（从环境变量读取 API Key）`));
    } else if (hasAnthropic && hasOpenAI) {
      // 如果同时配置了多个，优先使用 Anthropic
      // 临时移除 OpenAI 环境变量，确保使用 Anthropic
      delete process.env.OPENAI_API_KEY;
      const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      stagehandConfig.model = anthropicModel;
      console.log(chalk.cyan(`检测到多个API Key，优先使用 Anthropic 模型: ${anthropicModel}`));
    } else if (hasOpenAI) {
      // 如果只有OpenAI，使用 CustomOpenAIClient（支持代理）
      try {
        const openAIModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
        stagehandConfig.llmClient = new AISdkClient({
          model: OpenaiProvider.languageModel(openAIModel)
        });
        console.log(chalk.cyan(`✓ 已配置 OpenAI 模型: ${openAIModel}（使用 openaiProvider，支持代理）`));
      } catch (error: any) {
        console.error(chalk.red('\n✗ OpenAI客户端初始化失败:'));
        console.error(chalk.red(error.message));
        throw error;
      }
    } else if (hasGoogle) {
      // 如果只有Google，从环境变量读取模型名称（如果设置了）
      if (process.env.GOOGLE_MODEL) {
        stagehandConfig.model = process.env.GOOGLE_MODEL;
        console.log(chalk.cyan(`使用 Google 模型: ${process.env.GOOGLE_MODEL}`));
      } else {
        console.log(chalk.cyan('使用 Google 模型（自动检测）'));
      }
    }
    
    // 初始化Stagehand
    try {
      this.stagehand = new Stagehand(stagehandConfig);
      
      await this.stagehand.init();
      this.page = this.stagehand.context.pages()[0];
    } catch (error: any) {
      // 处理初始化错误，特别是 API 认证错误
      const errorMessage = error?.message || String(error || '未知错误');
      let errorString = '{}';
      try {
        errorString = JSON.stringify(error) || '{}';
      } catch {
        errorString = String(error || '未知错误');
      }
      
      // 确保都是字符串
      const safeErrorMessage = String(errorMessage || '未知错误');
      const safeErrorString = String(errorString || '{}');
      
      if (safeErrorMessage.includes('403') || safeErrorString.includes('forbidden') || safeErrorString.includes('Request not allowed')) {
        console.error(chalk.red('\n✗ API 认证失败 (403 Forbidden)'));
        console.error(chalk.yellow('可能的原因:'));
        console.error(chalk.yellow('  1. API Key 无效或已过期'));
        console.error(chalk.yellow('  2. API Key 没有正确的权限'));
        console.error(chalk.yellow('  3. API Key 格式不正确'));
        console.error(chalk.yellow('  4. 账户可能被限制或暂停'));
        console.error(chalk.yellow('\n请检查:'));
        if (hasAnthropic) {
          const key = process.env.ANTHROPIC_API_KEY || '';
          const keyPreview = key.length > 0 ? key.substring(0, 12) + '...' : '(未设置)';
          console.error(chalk.yellow(`  - ANTHROPIC_API_KEY 是否正确: ${keyPreview}`));
          console.error(chalk.yellow('  - 访问 https://console.anthropic.com/ 验证 API Key 状态'));
        }
        if (hasOpenAI) {
          console.error(chalk.yellow('  - OPENAI_API_KEY 是否正确'));
          console.error(chalk.yellow('  - 访问 https://platform.openai.com/api-keys 验证 API Key 状态'));
        }
        console.error(chalk.yellow('\n详细错误信息:'));
        console.error(chalk.red(safeErrorString));
      } else {
        console.error(chalk.red('\n✗ Stagehand 初始化失败:'));
        console.error(chalk.red(safeErrorMessage));
        if (error.stack) {
          console.error(chalk.gray(error.stack));
        }
      }
      throw error;
    }
    
    // 初始化操作记录器
    this.actionRecorder = new ActionRecorder(this.page);
    await this.actionRecorder.startRecording();
    
    // 初始化网络拦截器
    this.networkInterceptor = new NetworkInterceptor(this.page);
    
    // 如果提供了 Excel 文件：确保 data 目录下有对应 JSON，并读取 API endpoint 配置
    if (this.options.excelFile) {
      try {
        const { dataPath } = await ensureDataFileFromExcel(this.options.excelFile);
        this.dataPath = dataPath;
        console.log(chalk.green(`✓ 数据已同步到: ${dataPath}`));
        this.apiEndpoints = await parseApiEndpoints(this.options.excelFile);
        this.networkInterceptor.setEndpoints(this.apiEndpoints);
        console.log(chalk.green(`✓ 已加载 ${this.apiEndpoints.length} 个API endpoint配置`));
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法读取API配置: ${error.message}`));
      }
    }
    
    // 开始拦截网络请求
    await this.networkInterceptor.startIntercepting();
    
    console.log(chalk.green('✓ 记录模式已启动'));
    console.log(chalk.cyan('\n提示:'));
    console.log('  - 在浏览器中进行操作，系统会自动记录');
    if (this.apiEndpoints.length > 0) {
      console.log(`  - 已配置 ${this.apiEndpoints.length} 个API endpoint，将自动捕获其请求和响应`);
      console.log('  - 捕获的真实响应将自动生成mock配置');
    }
    console.log('  - 按 Ctrl+C 停止记录并保存结果');
    console.log('  - 记录的操作将保存到:', this.options.outputFile);
    console.log('');
  }

  /**
   * 导航到指定URL
   */
  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('记录器未初始化');
    }
    
    console.log(chalk.cyan(`导航到: ${url}`));
    await this.page.goto(url, { waitUntil: 'networkidle' as const });
    await this.page.waitForTimeout(2000); // 等待页面完全稳定
    
    // 导航后重新设置操作记录器（因为页面可能已重新加载，监听器会丢失）
    if (this.actionRecorder) {
      console.log(chalk.gray('  [记录器] 页面导航完成，等待页面稳定后重新设置监听器...'));
      // 再等待一下，确保页面完全加载
      await this.page.waitForTimeout(1000);
      await this.actionRecorder.startRecording();
    }
  }

  /**
   * 开始记录
   */
  async start(): Promise<void> {
    if (!this.page) {
      await this.init();
    }
    
    // 如果提供了URL，导航到该URL
    if (this.options.url) {
      await this.navigate(this.options.url);
    } else {
      console.log(chalk.yellow('未指定URL，请在浏览器中手动导航'));
    }
    
    // 等待用户操作（通过监听事件）
    console.log(chalk.green('\n开始记录用户操作...'));
    console.log(chalk.yellow('按 Ctrl+C 停止记录\n'));
  }

  /**
   * 停止记录并保存结果
   */
  async stop(): Promise<void> {
    console.log(chalk.cyan('\n正在停止记录...'));
    
    if (this.actionRecorder) {
      await this.actionRecorder.stopRecording();
    }
    
    if (this.networkInterceptor) {
      this.networkInterceptor.stopIntercepting();
    }
    
    // 收集记录的数据
    const requests = this.networkInterceptor?.getRecordedRequests() || [];
    const responses = this.networkInterceptor?.getRecordedResponses() || [];
    
    // 根据记录的响应生成mock配置
    const mockConfigs: any[] = [];
    const testCaseResponseMap = new Map<string, Map<string, NetworkResponse>>(); // testCaseId -> (apiUrl -> response)
    const testCaseRequestMap = new Map<string, Map<string, NetworkRequest>>(); // testCaseId -> (apiUrl -> request)
    
    // 为每个配置的endpoint生成mock配置，并按测试用例分组
    this.apiEndpoints.forEach(endpoint => {
      const endpointUrl = typeof endpoint.url === 'string' ? endpoint.url : endpoint.url.toString();
      const testCaseId = endpoint.testCaseId || '';
      const safeEndpointUrl = String(endpointUrl || '');
      
      // 找到匹配的请求和响应（安全地处理可能为 undefined 的 url）
      const matchingResponses = responses.filter(r => {
        const responseUrl = r?.url || '';
        return responseUrl.includes(safeEndpointUrl) || responseUrl === safeEndpointUrl;
      });
      const matchingRequests = requests.filter(r => {
        const requestUrl = r?.url || '';
        return requestUrl.includes(safeEndpointUrl) || requestUrl === safeEndpointUrl;
      });
      
      if (matchingResponses.length > 0) {
        // 使用最后一次响应作为mock数据
        const lastResponse = matchingResponses[matchingResponses.length - 1];
        const matchingRequest = matchingRequests.find(r => r.url === lastResponse.url) || matchingRequests[matchingRequests.length - 1];
        
        mockConfigs.push({
          url: endpointUrl,
          method: matchingRequest?.method || 'GET',
          mockResponse: {
            status: lastResponse.status,
            headers: lastResponse.headers,
            body: lastResponse.body
          }
        });
        
        // 按测试用例分组保存响应和请求
        if (testCaseId) {
          if (!testCaseResponseMap.has(testCaseId)) {
            testCaseResponseMap.set(testCaseId, new Map());
          }
          testCaseResponseMap.get(testCaseId)!.set(endpointUrl, lastResponse);
          
          if (matchingRequest) {
            if (!testCaseRequestMap.has(testCaseId)) {
              testCaseRequestMap.set(testCaseId, new Map());
            }
            testCaseRequestMap.get(testCaseId)!.set(endpointUrl, matchingRequest);
          }
        }
      }
    });
    
    // 如果提供了 Excel 文件，将请求和响应写入 data 目录下对应的 JSON
    if (this.dataPath && (testCaseResponseMap.size > 0 || testCaseRequestMap.size > 0)) {
      try {
        await saveApiRecords(
          this.dataPath,
          testCaseRequestMap,
          testCaseResponseMap,
          (body) => generateZodSchemaCode(body)
        );
        console.log(chalk.green(`✓ API 记录已写入: ${this.dataPath}`));
      } catch (error: any) {
        console.warn(chalk.yellow(`警告: 无法写入 JSON: ${error.message}`));
      }
    }
    
    const recordedData = {
      timestamp: new Date().toISOString(),
      url: this.options.url || '',
      actions: this.actionRecorder?.getActions() || [],
      actionDescriptions: this.actionRecorder?.getActionDescriptions() || [],
      networkRequests: requests,
      networkResponses: responses,
      apiEndpoints: this.apiEndpoints,
      mockConfigs: mockConfigs // 生成的mock配置
    };
    
    // 保存到文件
    try {
      const outputPath = this.options.outputFile;
      await writeFile(outputPath, JSON.stringify(recordedData, null, 2), 'utf-8');
      console.log(chalk.green(`✓ 记录已保存到: ${outputPath}`));
      
      // 生成测试步骤文件
      const stepsPath = outputPath.replace('.json', '-steps.txt');
      const steps = this.actionRecorder?.exportAsSteps() || [];
      await writeFile(stepsPath, steps.join('\n'), 'utf-8');
      console.log(chalk.green(`✓ 测试步骤已保存到: ${stepsPath}`));
      
      // 生成mock配置文件（如果有关注的API）
      if (mockConfigs.length > 0) {
        const mockConfigPath = outputPath.replace('.json', '-mock-config.json');
        await writeFile(mockConfigPath, JSON.stringify(mockConfigs, null, 2), 'utf-8');
        console.log(chalk.green(`✓ Mock配置已保存到: ${mockConfigPath}`));
        console.log(chalk.cyan(`  已为 ${mockConfigs.length} 个API endpoint生成mock配置`));
      }
      
      // 打印统计信息
      console.log(chalk.cyan('\n记录统计:'));
      console.log(`  操作数: ${recordedData.actions.length}`);
      console.log(`  网络请求数: ${recordedData.networkRequests.length}`);
      console.log(`  网络响应数: ${recordedData.networkResponses.length}`);
      if (mockConfigs.length > 0) {
        console.log(`  生成的Mock配置数: ${mockConfigs.length}`);
      }
      
    } catch (error: any) {
      console.error(chalk.red(`保存失败: ${error.message}`));
    }
    
    // 关闭浏览器
    if (this.stagehand) {
      await this.stagehand.close();
    }
    
    console.log(chalk.green('✓ 记录模式已停止'));
  }

  /**
   * 获取当前记录的操作
   */
  getActions(): RecordedAction[] {
    return this.actionRecorder?.getActions() || [];
  }

  /**
   * 获取操作描述列表
   */
  getActionDescriptions(): string[] {
    return this.actionRecorder?.getActionDescriptions() || [];
  }

  /**
   * 关闭记录器
   */
  async close(): Promise<void> {
    await this.stop();
  }
}
