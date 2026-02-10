import chalk from 'chalk';
import type { TestResult, TestStatistics } from '../executor/testExecutor.js';

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
}
