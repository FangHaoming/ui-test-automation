/**
 * Zod Schema生成器 - 从JSON数据自动生成Zod校验规则
 */

import { z } from 'zod';

/**
 * 从JSON数据生成Zod Schema
 * @param data - 要生成schema的数据
 * @param options - 选项
 * @returns Zod Schema字符串
 */
export function generateZodSchemaFromData(
  data: any,
  options: {
    strict?: boolean; // 是否严格模式（所有字段必填）
    allowExtra?: boolean; // 是否允许额外字段
  } = {}
): string {
  const { strict = false, allowExtra = true } = options;
  
  const schema = inferZodSchema(data, { strict, allowExtra });
  return schema.toString();
}

/**
 * 从JSON数据推断Zod Schema
 */
function inferZodSchema(
  data: any,
  options: { strict: boolean; allowExtra: boolean }
): z.ZodTypeAny {
  if (data === null) {
    return z.null();
  }
  
  if (data === undefined) {
    return z.undefined();
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return z.array(z.any());
    }
    // 使用第一个元素的schema
    const itemSchema = inferZodSchema(data[0], options);
    return z.array(itemSchema);
  }
  
  if (typeof data === 'object') {
    const shape: Record<string, z.ZodTypeAny> = {};
    
    for (const [key, value] of Object.entries(data)) {
      const fieldSchema = inferZodSchema(value, options);
      shape[key] = options.strict ? fieldSchema : fieldSchema.optional();
    }
    
    const objectSchema = z.object(shape);
    return options.allowExtra ? objectSchema.passthrough() : objectSchema.strict();
  }
  
  // 基本类型
  switch (typeof data) {
    case 'string':
      return z.string();
    case 'number':
      return Number.isInteger(data) ? z.number().int() : z.number();
    case 'boolean':
      return z.boolean();
    default:
      return z.any();
  }
}

/**
 * 从Zod Schema字符串解析并验证数据
 * @param schemaStr - Zod Schema字符串（需要包含z对象，如：z.object({...})）
 * @param data - 要验证的数据
 * @param z - Zod实例（需要从外部传入）
 * @returns 验证结果
 */
export function validateWithZodSchema(
  schemaStr: string,
  data: any,
  z: any
): { success: boolean; error?: string; data?: any } {
  try {
    // 使用Function构造器来安全地执行schema代码
    const schema = new Function('z', `return ${schemaStr}`)(z);
    
    if (typeof schema.parse !== 'function') {
      return {
        success: false,
        error: '无效的Zod schema'
      };
    }
    
    const result = schema.parse(data);
    return {
      success: true,
      data: result
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || '验证失败'
    };
  }
}

/**
 * 生成更友好的Zod Schema代码字符串
 * @param data - 要生成schema的数据
 * @returns Zod Schema代码字符串（可以直接eval使用）
 */
export function generateZodSchemaCode(data: any): string {
  // 直接生成代码字符串
  return generateSchemaCode(data, 0);
}

/**
 * 生成Schema代码字符串
 */
function generateSchemaCode(data: any, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  
  if (data === null) {
    return 'z.null()';
  }
  
  if (data === undefined) {
    return 'z.undefined()';
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return 'z.array(z.any())';
    }
    const itemCode = generateSchemaCode(data[0], indent);
    return `z.array(${itemCode})`;
  }
  
  if (typeof data === 'object') {
    const entries: string[] = [];
    
    for (const [key, value] of Object.entries(data)) {
      const valueCode = generateSchemaCode(value, indent + 1);
      entries.push(`${spaces}  ${key}: ${valueCode}`);
    }
    
    return `z.object({\n${entries.join(',\n')}\n${spaces}}).passthrough()`;
  }
  
  switch (typeof data) {
    case 'string':
      return 'z.string()';
    case 'number':
      return Number.isInteger(data) ? 'z.number().int()' : 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    default:
      return 'z.any()';
  }
}
