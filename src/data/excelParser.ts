import ExcelJS from 'exceljs';
import type { ApiEndpoint } from '../utils/networkInterceptor.js';

/**
 * 测试用例接口
 */
export interface TestCase {
  id: string;
  name: string;
  url: string;
  steps: string[];
  expectedResult: string;
  description: string;
}

/**
 * API Endpoint配置接口（简化版，只需要URL）
 */
export interface ApiEndpointConfig {
  url: string;
}

/**
 * 解析Excel测试用例文件
 * @param filePath - Excel文件路径
 * @returns 测试用例数组
 */
export async function parseTestCases(filePath: string): Promise<TestCase[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  
  const worksheet = workbook.worksheets[0];
  const testCases: TestCase[] = [];
  
  // 跳过表头，从第二行开始读取
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    
    // 如果第一列为空，跳过该行
    if (!row.getCell(1).value) {
      continue;
    }
    
    // 安全地提取单元格值（处理超链接、公式等特殊情况）
    const getCellValue = (cell: any): string => {
      if (!cell || !cell.value) return '';
      
      // 如果单元格包含超链接，使用超链接的文本或地址
      if (cell.value.text) {
        return String(cell.value.text);
      }
      
      // 如果单元格包含超链接对象，使用地址
      if (cell.value.hyperlink) {
        return String(cell.value.hyperlink);
      }
      
      // 如果是对象，尝试获取text属性
      if (typeof cell.value === 'object' && cell.value.text) {
        return String(cell.value.text);
      }
      
      // 其他情况直接转换为字符串
      return String(cell.value);
    };

    const testCase: TestCase = {
      id: getCellValue(row.getCell(1)) || `TC-${rowNumber - 1}`,
      name: getCellValue(row.getCell(2)),
      url: getCellValue(row.getCell(3)),
      steps: parseSteps(getCellValue(row.getCell(4))),
      expectedResult: getCellValue(row.getCell(5)),
      description: getCellValue(row.getCell(6))
    };

    // 只要有测试 ID（第一列）就解析并加入，不要求必须有测试步骤等
    testCases.push(testCase);
  }
  
  return testCases;
}

/**
 * 解析测试步骤字符串
 * 支持多行步骤，每行一个步骤
 * @param stepsText - 步骤文本
 * @returns 步骤数组
 */
function parseSteps(stepsText: string): string[] {
  if (!stepsText) return [];
  
  return stepsText
    .split('\n')
    .map(step => step.trim())
    .filter(step => step.length > 0);
}

/**
 * 创建示例Excel模板
 * @param filePath - 保存路径
 */
export async function createTemplate(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('测试用例');
  
  // 设置表头
  worksheet.columns = [
    { header: '用例ID', key: 'id', width: 15 },
    { header: '用例名称', key: 'name', width: 30 },
    { header: '测试URL', key: 'url', width: 50 },
    { header: '测试步骤', key: 'steps', width: 60 },
    { header: '预期结果', key: 'expectedResult', width: 50 },
    { header: '备注', key: 'description', width: 30 },
    { header: 'API URL', key: 'apiUrl', width: 50 },
    { header: 'API Request', key: 'apiRequest', width: 80 },
    { header: 'API Response', key: 'apiResponse', width: 80 }
  ];
  
  // 设置表头样式
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };
  
  // 添加示例数据
  worksheet.addRow({
    id: 'TC-001',
    name: '登录功能测试',
    url: 'https://example.com/login',
    steps: '打开登录页面\n在用户名框输入 admin\n在密码框输入 password123\n点击登录按钮',
    expectedResult: '成功跳转到首页，显示欢迎信息',
    description: '验证正常登录流程'
  });
  
  worksheet.addRow({
    id: 'TC-002',
    name: '搜索功能测试',
    url: 'https://example.com',
    steps: '在搜索框输入 测试关键词\n点击搜索按钮',
    expectedResult: '显示搜索结果列表，包含相关结果',
    description: '验证搜索功能'
  });
  
  await workbook.xlsx.writeFile(filePath);
  console.log(`模板文件已创建: ${filePath}`);
}

/**
 * 解析API Endpoint配置（从测试用例表的第7列）
 * 支持一个测试用例对应多个API URL（用换行或分号分隔）
 * @param filePath - Excel文件路径
 * @returns API Endpoint配置数组，包含测试用例ID和对应的URL列表
 */
export interface TestCaseApiConfig {
  testCaseId: string;
  apiUrls: string[];
}

export async function parseApiEndpoints(
  filePath: string
): Promise<ApiEndpoint[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  
  const worksheet = workbook.worksheets[0];
  const endpoints: ApiEndpoint[] = [];
  
  // 检查是否有API URL列（第7列）
  const headerRow = worksheet.getRow(1);
  const apiHeader = headerRow.getCell(7).value?.toString() || '';
  const safeApiHeader = String(apiHeader || '');
  
  if (!safeApiHeader || (!safeApiHeader.includes('API') && !safeApiHeader.includes('接口'))) {
    return endpoints;
  }
  
  // 从第7列读取API配置（支持多个URL，用换行或分号分隔）
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const testCaseId = row.getCell(1).value?.toString() || '';
    const apiUrlCell = row.getCell(7).value?.toString();
    
    if (apiUrlCell && apiUrlCell.trim() && testCaseId) {
      // 支持换行或分号分隔的多个URL
      const urls = apiUrlCell
        .split(/[\n;]/)
        .map(url => url.trim())
        .filter(url => url.length > 0);
      
      urls.forEach(url => {
        endpoints.push({
          url: url,
          recordOnly: true, // 记录模式下，先只记录，后续会用真实响应作为mock
          testCaseId: testCaseId // 记录对应的测试用例ID
        });
      });
    }
  }
  
  return endpoints;
}

/**
 * 获取测试用例的API配置映射
 * @param filePath - Excel文件路径
 * @returns 测试用例ID到API URL列表的映射
 */
export async function getTestCaseApiMapping(
  filePath: string
): Promise<Map<string, string[]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  
  const worksheet = workbook.worksheets[0];
  const mapping = new Map<string, string[]>();
  
  // 检查是否有API URL列（第7列）
  const headerRow = worksheet.getRow(1);
  const apiHeader = headerRow.getCell(7).value?.toString() || '';
  const safeApiHeader = String(apiHeader || '');
  
  if (!safeApiHeader || (!safeApiHeader.includes('API') && !safeApiHeader.includes('接口'))) {
    return mapping;
  }
  
  // 从第7列读取API配置
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const testCaseId = row.getCell(1).value?.toString() || '';
    const apiUrlCell = row.getCell(7).value?.toString();
    
    if (apiUrlCell && apiUrlCell.trim() && testCaseId) {
      // 支持换行或分号分隔的多个URL
      const urls = apiUrlCell
        .split(/[\n;]/)
        .map(url => url.trim())
        .filter(url => url.length > 0);
      
      if (urls.length > 0) {
        mapping.set(testCaseId, urls);
      }
    }
  }
  
  return mapping;
}

/**
 * 创建包含API配置的Excel模板
 * @param filePath - 保存路径
 */
export async function createTemplateWithApiConfig(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  
  // 创建测试用例工作表（包含API配置列）
  const testCaseSheet = workbook.addWorksheet('测试用例');
  testCaseSheet.columns = [
    { header: '用例ID', key: 'id', width: 15 },
    { header: '用例名称', key: 'name', width: 30 },
    { header: '测试URL', key: 'url', width: 50 },
    { header: '测试步骤', key: 'steps', width: 60 },
    { header: '预期结果', key: 'expectedResult', width: 50 },
    { header: '备注', key: 'description', width: 30 },
    { header: 'API URL', key: 'apiUrl', width: 50 },
    { header: 'API Request', key: 'apiRequest', width: 80 },
    { header: 'API Response', key: 'apiResponse', width: 80 }
  ];
  
  // 设置表头样式
  testCaseSheet.getRow(1).font = { bold: true };
  testCaseSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };
  
  // 添加示例数据（一个测试用例对应多个API）
  testCaseSheet.addRow({
    id: 'TC-001',
    name: '登录功能测试',
    url: 'https://example.com/login',
    steps: '打开登录页面\n在用户名框输入 admin\n在密码框输入 password123\n点击登录按钮',
    expectedResult: '成功跳转到首页，显示欢迎信息',
    description: '验证正常登录流程',
    apiUrl: '/api/login\n/api/user',
    apiRequest: '（记录操作时自动填充Zod校验规则）',
    apiResponse: '（记录操作时自动填充）'
  });
  
  testCaseSheet.addRow({
    id: 'TC-002',
    name: '搜索功能测试',
    url: 'https://example.com',
    steps: '在搜索框输入 测试关键词\n点击搜索按钮',
    expectedResult: '显示搜索结果列表，包含相关结果',
    description: '验证搜索功能',
    apiUrl: '/api/search',
    apiRequest: '（记录操作时自动填充Zod校验规则）',
    apiResponse: '（记录操作时自动填充）'
  });
  
  await workbook.xlsx.writeFile(filePath);
  console.log(`模板文件已创建: ${filePath}`);
  console.log('提示：API URL列支持多个URL，用换行或分号分隔');
  console.log('     API Request列：记录操作时自动填充Zod校验规则（作为预期结果）');
  console.log('     API Response列：记录操作时自动填充真实的响应数据（仅记录，不校验）');
}
