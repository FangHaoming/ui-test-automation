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
   * 开始拦截网络请求
   * 注意：Stagehand v3 的 Page 类不支持 Playwright 的 route() 和 on() 方法
   * 这里实现一个简化版本，使用 CDP 来记录网络请求
   * Mock 功能需要更复杂的实现，暂时只支持记录
   */
  async startIntercepting(): Promise<void> {
    if (this.isIntercepting) {
      return;
    }

    this.isIntercepting = true;
    this.recordedRequests = [];
    this.recordedResponses = [];

    // 使用 CDP 启用 Network 域来记录网络活动
    try {
      await this.page.sendCDP('Network.enable');
      console.log('[网络拦截] 已启用网络记录（注意：Mock 功能在 Stagehand v3 中需要额外实现）');
    } catch (error) {
      console.warn('[网络拦截] 无法启用网络记录:', error);
    }

    // 注意：由于 Stagehand v3 的 Page 类不支持事件监听，
    // 网络请求和响应的记录需要通过其他方式实现
    // 这里暂时留空，实际使用时需要通过 CDP 事件或其他机制来实现
    // 如果需要完整的网络拦截功能，建议使用 Stagehand 的 context 或其他 API
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
    // 禁用 Network 和 Fetch 域
    try {
      await this.page.sendCDP('Network.disable');
      await this.page.sendCDP('Fetch.disable');
    } catch (error) {
      // 忽略错误
    }
    // 清理监听器
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
