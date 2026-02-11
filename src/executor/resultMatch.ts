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
  const failureKeywords = ['失败', '错误', 'error', 'fail', 'wrong', 'exception', '未通过', '未找到'];

  // 1. 只要实际结果里出现明显失败/错误关键词，直接认为不匹配
  if (failureKeywords.some(keyword => actualLower.includes(keyword.toLowerCase()))) {
    return false;
  }

  // 2. 若预期中包含 URL，只要实际结果中也包含这些 URL，即认为匹配（前提是没有失败关键词）
  const urlRegex = /(https?:\/\/[^\s"']+)/gi;
  const expectedUrls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(safeExpected)) !== null) {
    expectedUrls.push(match[1] || match[0]);
  }
  if (expectedUrls.length > 0) {
    const allUrlsMatched = expectedUrls.every(url =>
      actualLower.includes(url.toLowerCase())
    );
    if (allUrlsMatched) {
      return true;
    }
  }

  // 3. 若预期里本身包含“成功/通过/显示”等正向关键词，
  //    则希望实际结果中也能看到同类成功关键词；若没有，则继续用后续规则判断，不直接判失败
  if (successKeywords.some(keyword => expectedLower.includes(keyword.toLowerCase()))) {
    const hasSuccessInActual = successKeywords.some(keyword =>
      actualLower.includes(keyword.toLowerCase())
    );
    if (hasSuccessInActual) {
      return true;
    }
  }

  // 4. 优先匹配预期中带引号的“关键文案”
  //    例如：页面里有“创建主机”按钮；或包含 '创建主机' 这样的片段
  const quotedTokens: string[] = [];
  const quoteRegex = /[“"']([^”"']+)[”"']/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRegex.exec(safeExpected)) !== null) {
    const token = m[1].trim();
    if (token.length > 0) quotedTokens.push(token);
  }

  if (quotedTokens.length > 0) {
    // 所有预期中的“关键文案”都能在实际结果里找到，则认为匹配
    const allQuotedMatched = quotedTokens.every(token => safeActual.includes(token));
    if (allQuotedMatched) return true;
  }

  // 5. 其次，对中文用例：提取预期中的连续中文片段（长度>=2），
  //    只要有一个重要中文片段出现在实际结果中即可认为基本匹配。
  const chineseTokens = safeExpected.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  if (chineseTokens.length > 0) {
    const hasChineseMatch = chineseTokens.some(token => safeActual.includes(token));
    if (hasChineseMatch) return true;
  }

  // 6. 兜底逻辑：英文/混合场景，尝试整体包含或按空格拆分匹配
  if (actualLower.includes(expectedLower)) return true;

  const expectedWords = expectedLower.split(/\s+/).filter(Boolean);
  if (expectedWords.length > 0 && expectedWords.some(word => actualLower.includes(word))) {
    return true;
  }

  return false;
}
