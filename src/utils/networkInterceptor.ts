/**
 * 网络请求拦截器 - 根据Excel中列出的API endpoint记录网络请求并mock response
 */

export interface ApiEndpoint {
  url: string | RegExp;
  method?: string;
  mockResponse?: any;
  recordOnly?: boolean; // 仅记录，不mock（记录模式下会自动捕获真实响应作为mock）
  testCaseId?: string; // 对应的测试用例ID
}

export interface NetworkRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
}

export interface NetworkResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body?: any;
  timestamp: number;
}

export class NetworkInterceptor {
  private page: any;
  private cdpSession: any = null;
  private endpoints: ApiEndpoint[] = [];
  private recordedRequests: NetworkRequest[] = [];
  private recordedResponses: NetworkResponse[] = [];
  private isIntercepting: boolean = false;
  private requestListener?: (request: any) => void;
  private responseListener?: (response: any) => void;

  constructor(page: any) {
    this.page = page;
  }

  /**
   * 设置要拦截的API endpoints
   */
  setEndpoints(endpoints: ApiEndpoint[]): void {
    this.endpoints = endpoints;
  }

  /**
   * 发送 CDP 命令：Playwright 的 page 无 sendCDP，需通过 context.newCDPSession(page) 获取 session 后 send
   */
  private async sendCDP(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (typeof this.page.sendCDP === 'function') {
      return (this.page as any).sendCDP(method, params);
    }
    if (!this.cdpSession) {
      const ctx = typeof this.page.context === 'function' ? this.page.context() : this.page._context;
      if (ctx && typeof ctx.newCDPSession === 'function') {
        this.cdpSession = await ctx.newCDPSession(this.page);
      }
    }
    if (this.cdpSession && typeof this.cdpSession.send === 'function') {
      return this.cdpSession.send(method as any, params);
    }
    throw new Error('CDP session 不可用');
  }

  /**
   * 开始拦截网络请求
   * Playwright 的 Page 无 sendCDP，使用 context.newCDPSession(page) 获取 session 后发送 CDP
   */
  async startIntercepting(): Promise<void> {
    if (this.isIntercepting) {
      return;
    }

    this.isIntercepting = true;
    this.recordedRequests = [];
    this.recordedResponses = [];

    try {
      await this.sendCDP('Network.enable');
      console.log('[网络拦截] 已启用网络记录');
    } catch (error) {
      console.warn('[网络拦截] 无法启用网络记录 (CDP):', error);
      // 即使启用 Network 失败，下面仍然尝试用 Playwright 的 page 事件记录请求
    }

    // 使用 Playwright 的 page.on('request' | 'response') 记录网络请求与响应，
    // 根据已配置的 endpoints 过滤后写入 recordedRequests / recordedResponses。
    // 这里只做“记录”，不对请求进行拦截或 mock（recordOnly 语义）。
    try {
      if (!this.page || typeof this.page.on !== 'function') {
        console.warn('[网络拦截] 当前 page 不支持事件订阅，无法记录请求/响应');
        return;
      }

      this.requestListener = (request: any) => {
        try {
          const url = String(request.url() || '');
          const method = String(request.method() || 'GET');
          const endpoint = this.findMatchingEndpoint(url, method);
          if (!endpoint) return;

          const headers = (request.headers?.() || {}) as Record<string, string>;
          const postData = request.postData?.() as string | undefined;

          this.recordedRequests.push({
            url,
            method,
            headers,
            postData,
            timestamp: Date.now()
          });
        } catch {
          // 单个事件解析失败不影响整体
        }
      };

      this.responseListener = async (response: any) => {
        try {
          const url = String(response.url() || '');
          const status = Number(response.status?.() ?? response.status() ?? 0);
          const endpoint = this.findMatchingEndpoint(url, undefined);
          if (!endpoint) return;

          let body: any = undefined;
          try {
            // Playwright 的 Response.body() 可能抛异常（如非 text/JSON），此处兜底为字符串
            const buf: Buffer = await response.body();
            const text = buf.toString('utf-8');
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          } catch {
            // 获取 body 失败时，仅记录基础信息
          }

          const headers = (response.headers?.() || {}) as Record<string, string>;

          this.recordedResponses.push({
            url,
            status,
            headers,
            body,
            timestamp: Date.now()
          });
        } catch {
          // 单个事件解析失败不影响整体
        }
      };

      this.page.on('request', this.requestListener);
      this.page.on('response', this.responseListener);
    } catch (error) {
      console.warn('[网络拦截] 订阅 Playwright 网络事件失败:', error);
    }
  }

  /**
   * 查找匹配的endpoint
   */
  private findMatchingEndpoint(url: string, method?: string): ApiEndpoint | undefined {
    // 安全地处理可能为 undefined 的 url
    const safeUrl = String(url || '');
    return this.endpoints.find(endpoint => {
      // URL匹配
      let urlMatches = false;
      if (typeof endpoint.url === 'string') {
        const safeEndpointUrl = String(endpoint.url || '');
        urlMatches = safeUrl.includes(safeEndpointUrl) || safeUrl === safeEndpointUrl;
      } else if (endpoint.url instanceof RegExp) {
        urlMatches = endpoint.url.test(safeUrl);
      }

      // 方法匹配（如果指定了方法）
      const methodMatches = !endpoint.method || !method || endpoint.method.toUpperCase() === method.toUpperCase();

      return urlMatches && methodMatches;
    });
  }

  /**
   * 停止拦截
   */
  async stopIntercepting(): Promise<void> {
    this.isIntercepting = false;
    try {
      await this.sendCDP('Network.disable');
      await this.sendCDP('Fetch.disable');
    } catch (error) {
      // 忽略错误
    }
    this.cdpSession = null;

    // 解除 Playwright 事件监听，避免重复记录
    try {
      if (this.page && typeof this.page.off === 'function') {
        if (this.requestListener) {
          this.page.off('request', this.requestListener);
        }
        if (this.responseListener) {
          this.page.off('response', this.responseListener);
        }
      }
    } catch {
      // 忽略解除监听时的错误
    }

    this.requestListener = undefined;
    this.responseListener = undefined;
  }

  /**
   * 获取记录的请求
   */
  getRecordedRequests(): NetworkRequest[] {
    return this.recordedRequests;
  }

  /**
   * 获取记录的响应
   */
  getRecordedResponses(): NetworkResponse[] {
    return this.recordedResponses;
  }

  /**
   * 获取指定URL的请求和响应
   */
  getRequestResponse(url: string): { request?: NetworkRequest; response?: NetworkResponse } {
    const request = this.recordedRequests.find(r => r.url === url);
    const response = this.recordedResponses.find(r => r.url === url);
    return { request, response };
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.recordedRequests = [];
    this.recordedResponses = [];
  }

  /**
   * 导出记录的请求为JSON
   */
  exportRequests(): string {
    return JSON.stringify(this.recordedRequests, null, 2);
  }

  /**
   * 导出记录的响应为JSON
   */
  exportResponses(): string {
    return JSON.stringify(this.recordedResponses, null, 2);
  }
}
