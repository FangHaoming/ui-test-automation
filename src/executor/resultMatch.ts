/**
 * 预期结果与实际结果的匹配逻辑
 */

/**
 * 检查结果是否匹配
 * @param expected - 预期结果
 * @param actual - 实际结果
 * @returns 是否匹配
 */
export function checkResultMatch(expected: string, actual: string): boolean {
  const safeExpected = String(expected || '');
  const safeActual = String(actual || '');

  const expectedLower = safeExpected.toLowerCase();
  const actualLower = safeActual.toLowerCase();

  const successKeywords = ['成功', '通过', '显示', '跳转', '出现', '正确', 'success', 'pass', 'show', 'display'];
  const failureKeywords = ['失败', '错误', '失败', 'error', 'fail', 'wrong'];

  if (failureKeywords.some(keyword => actualLower.includes(keyword))) {
    return false;
  }

  if (successKeywords.some(keyword => expectedLower.includes(keyword))) {
    return successKeywords.some(keyword => actualLower.includes(keyword));
  }

  return actualLower.includes(expectedLower) ||
    expectedLower.split(' ').some(word => actualLower.includes(word));
}
