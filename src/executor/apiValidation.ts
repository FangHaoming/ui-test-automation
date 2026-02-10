/**
 * API 请求 Zod schema 校验
 */

import type { NetworkInterceptor } from '../utils/networkInterceptor.js';
import { validateWithZodSchema } from '../utils/zodSchemaGenerator.js';

/**
 * 验证 API 请求是否符合 Zod schema
 */
export async function validateApiRequests(
  networkInterceptor: NetworkInterceptor | null,
  _testCaseId: string,
  apiRequestSchemas: Map<string, string>
): Promise<{ success: boolean; error?: string }> {
  if (!networkInterceptor) {
    return { success: true };
  }

  const recordedRequests = networkInterceptor.getRecordedRequests();
  const errors: string[] = [];

  for (const [apiUrl, zodSchemaStr] of apiRequestSchemas.entries()) {
    const matchingRequests = recordedRequests.filter(r => {
      const requestUrl = r?.url || '';
      const safeApiUrl = String(apiUrl || '');
      return requestUrl.includes(safeApiUrl) || requestUrl === safeApiUrl;
    });

    if (matchingRequests.length === 0) {
      errors.push(`未找到API请求: ${apiUrl}`);
      continue;
    }

    for (const request of matchingRequests) {
      try {
        let requestBody: any = {};
        if (request.postData) {
          try {
            requestBody = JSON.parse(request.postData);
          } catch {
            requestBody = { raw: request.postData };
          }
        }

        const { z } = await import('zod');
        const validationResult = validateWithZodSchema(zodSchemaStr, requestBody, z);

        if (!validationResult.success) {
          errors.push(`API ${apiUrl} 请求验证失败: ${validationResult.error}`);
        }
      } catch (error: any) {
        errors.push(`API ${apiUrl} 请求验证出错: ${error.message}`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      error: errors.join('; ')
    };
  }

  return { success: true };
}
