/**
 * 文件系统相关工具
 */

import { mkdir } from 'fs/promises';

/**
 * 确保指定目录存在（递归创建，若已存在则不报错）
 * @param dirPath - 目录绝对路径或相对路径（相对 process.cwd()）
 * @returns 创建的目录路径
 */
export async function ensureDir(dirPath: string): Promise<string> {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}
