import chalk from 'chalk';
import ExcelJS from 'exceljs';
import type { TestResult, TestStatistics } from './testExecutor.js';

/**
 * 生成测试报告
 */
export class ReportGenerator {
  /**
   * 在控制台打印测试报告
   * @param results - 测试结果数组
   * @param statistics - 统计信息
   */
  static printConsoleReport(results: TestResult[], statistics: TestStatistics): void {
    console.log('\n' + '='.repeat(80));
    console.log(chalk.bold.cyan('测试报告'));
    console.log('='.repeat(80));
    
    // 统计信息
    console.log('\n' + chalk.bold('测试统计:'));
    console.log(`  总用例数: ${statistics.total}`);
    console.log(`  ${chalk.green('通过')}: ${chalk.green(statistics.passed)}`);
    console.log(`  ${chalk.red('失败')}: ${chalk.red(statistics.failed)}`);
    console.log(`  通过率: ${statistics.passRate}`);
    console.log(`  总耗时: ${statistics.totalDuration}`);
    console.log(`  平均耗时: ${statistics.averageDuration}`);
    
    // 详细结果
    console.log('\n' + chalk.bold('详细结果:'));
    console.log('-'.repeat(80));
    
    results.forEach(result => {
      const statusColor = result.status === 'passed' ? chalk.green : chalk.red;
      const statusIcon = result.status === 'passed' ? '✓' : '✗';
      
      console.log(`\n${statusColor(statusIcon)} ${result.id} - ${result.name}`);
      console.log(`  状态: ${statusColor(result.status.toUpperCase())}`);
      // 安全地显示URL（确保是字符串）
      const urlDisplay = result.url ? String(result.url) : 'N/A';
      console.log(`  URL: ${urlDisplay}`);
      console.log(`  耗时: ${result.duration}ms`);
      
      if (result.steps && result.steps.length > 0) {
        console.log(`  步骤:`);
        result.steps.forEach(step => {
          const stepStatus = step.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
          console.log(`    ${stepStatus} ${step.description}`);
          if (step.error) {
            console.log(`      ${chalk.red('错误: ' + step.error)}`);
          }
        });
      }
      
      if (result.expectedResult) {
        console.log(`  预期结果: ${result.expectedResult}`);
      }
      
      if (result.actualResult) {
        console.log(`  实际结果: ${result.actualResult}`);
      }
      
      if (result.error) {
        console.log(`  ${chalk.red('错误信息: ' + result.error)}`);
      }
    });
    
    console.log('\n' + '='.repeat(80) + '\n');
  }

  /**
   * 生成Excel测试报告
   * @param results - 测试结果数组
   * @param statistics - 统计信息
   * @param outputPath - 输出文件路径
   */
  static async generateExcelReport(
    results: TestResult[],
    statistics: TestStatistics,
    outputPath: string
  ): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('测试报告');
    
    // 设置表头
    worksheet.columns = [
      { header: '用例ID', key: 'id', width: 15 },
      { header: '用例名称', key: 'name', width: 30 },
      { header: '测试URL', key: 'url', width: 50 },
      { header: '状态', key: 'status', width: 10 },
      { header: '测试步骤', key: 'steps', width: 60 },
      { header: '预期结果', key: 'expectedResult', width: 50 },
      { header: '实际结果', key: 'actualResult', width: 50 },
      { header: '错误信息', key: 'error', width: 50 },
      { header: '耗时(ms)', key: 'duration', width: 15 }
    ];
    
    // 设置表头样式
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // 添加统计信息
    worksheet.insertRow(1, ['测试统计', '', '', '', '', '', '', '', '']);
    worksheet.mergeCells('A1:I1');
    worksheet.getCell('A1').font = { bold: true, size: 12 };
    worksheet.getCell('A1').value = `测试统计 - 总计: ${statistics.total} | 通过: ${statistics.passed} | 失败: ${statistics.failed} | 通过率: ${statistics.passRate}`;
    
    // 添加测试结果
    results.forEach(result => {
      const stepsText = result.steps
        ? result.steps.map((s, i) => `${i + 1}. ${s.description} (${s.status})`).join('\n')
        : '';
      
      worksheet.addRow({
        id: result.id,
        name: result.name,
        url: result.url ? String(result.url) : '',
        status: result.status,
        steps: stepsText,
        expectedResult: result.expectedResult || '',
        actualResult: result.actualResult || '',
        error: result.error || '',
        duration: result.duration
      });
      
      // 设置状态列颜色
      const row = worksheet.lastRow;
      if (row) {
        const statusCell = row.getCell('status');
        if (result.status === 'passed') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF90EE90' } // 浅绿色
          };
        } else {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFB6C1' } // 浅红色
          };
        }
      }
    });
    
    await workbook.xlsx.writeFile(outputPath);
    console.log(chalk.green(`\n测试报告已保存到: ${outputPath}`));
  }

  /**
   * 生成HTML测试报告
   * @param results - 测试结果数组
   * @param statistics - 统计信息
   * @param outputPath - 输出文件路径
   */
  static async generateHTMLReport(
    results: TestResult[],
    statistics: TestStatistics,
    outputPath: string
  ): Promise<void> {
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UI自动化测试报告</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 30px;
            border-bottom: 3px solid #4CAF50;
            padding-bottom: 10px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
        }
        .stat-card h3 {
            font-size: 14px;
            opacity: 0.9;
            margin-bottom: 10px;
        }
        .stat-card .value {
            font-size: 32px;
            font-weight: bold;
        }
        .stat-card.passed { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
        .stat-card.failed { background: linear-gradient(135deg, #ee0979 0%, #ff6a00 100%); }
        .test-case {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            background: #fafafa;
        }
        .test-case.passed { border-left: 5px solid #4CAF50; }
        .test-case.failed { border-left: 5px solid #f44336; }
        .test-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .test-title {
            font-size: 18px;
            font-weight: bold;
            color: #333;
        }
        .test-status {
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
        }
        .test-status.passed {
            background: #4CAF50;
            color: white;
        }
        .test-status.failed {
            background: #f44336;
            color: white;
        }
        .test-info {
            margin: 10px 0;
            color: #666;
        }
        .test-steps {
            margin: 15px 0;
            padding: 15px;
            background: white;
            border-radius: 5px;
        }
        .step {
            padding: 8px;
            margin: 5px 0;
            border-left: 3px solid #ddd;
            padding-left: 15px;
        }
        .step.passed { border-left-color: #4CAF50; }
        .step.failed { border-left-color: #f44336; }
        .error {
            background: #ffebee;
            border-left: 4px solid #f44336;
            padding: 15px;
            margin: 10px 0;
            border-radius: 5px;
            color: #c62828;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>UI自动化测试报告</h1>
        
        <div class="stats">
            <div class="stat-card">
                <h3>总用例数</h3>
                <div class="value">${statistics.total}</div>
            </div>
            <div class="stat-card passed">
                <h3>通过</h3>
                <div class="value">${statistics.passed}</div>
            </div>
            <div class="stat-card failed">
                <h3>失败</h3>
                <div class="value">${statistics.failed}</div>
            </div>
            <div class="stat-card">
                <h3>通过率</h3>
                <div class="value">${statistics.passRate}</div>
            </div>
        </div>
        
        ${results.map(result => `
            <div class="test-case ${result.status}">
                <div class="test-header">
                    <div class="test-title">${this.escapeHtml(result.id)} - ${this.escapeHtml(result.name)}</div>
                    <div class="test-status ${result.status}">${result.status === 'passed' ? '通过' : '失败'}</div>
                </div>
                <div class="test-info">
                    <strong>URL:</strong> ${this.escapeHtml(result.url ? String(result.url) : 'N/A')}<br>
                    <strong>耗时:</strong> ${result.duration}ms
                </div>
                ${result.steps && result.steps.length > 0 ? `
                    <div class="test-steps">
                        <strong>测试步骤:</strong>
                        ${result.steps.map(step => `
                            <div class="step ${step.status}">
                                ${step.stepNumber}. ${this.escapeHtml(step.description)}
                                ${step.error ? `<div style="color: #f44336; margin-top: 5px;">错误: ${this.escapeHtml(step.error)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                ${result.expectedResult ? `<div class="test-info"><strong>预期结果:</strong> ${this.escapeHtml(result.expectedResult)}</div>` : ''}
                ${result.actualResult ? `<div class="test-info"><strong>实际结果:</strong> ${this.escapeHtml(result.actualResult)}</div>` : ''}
                ${result.error ? `<div class="error"><strong>错误信息:</strong> ${this.escapeHtml(result.error)}</div>` : ''}
            </div>
        `).join('')}
    </div>
</body>
</html>
    `.trim();

    const fs = await import('fs/promises');
    await fs.writeFile(outputPath, html, 'utf-8');
    console.log(chalk.green(`HTML测试报告已保存到: ${outputPath}`));
  }

  /**
   * HTML转义工具函数
   * @param text - 要转义的文本
   * @returns 转义后的文本
   */
  private static escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
