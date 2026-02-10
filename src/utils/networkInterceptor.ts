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
      console.warn('[网络拦截] 无法启用网络记录:', error);
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
    delete (this.page as any)._networkRequestListener;
    delete (this.page as any)._networkResponseListener;
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
