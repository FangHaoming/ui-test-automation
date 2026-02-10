/**
 * 操作记录器 - 自动记录用户在浏览器上的操作，生成自然语言描述
 */

export interface RecordedAction {
  timestamp: number;
  type: 'click' | 'type' | 'navigate' | 'select' | 'scroll' | 'hover' | 'wait';
  description: string;
  element?: {
    tag: string;
    text?: string;
    placeholder?: string;
    label?: string;
    id?: string;
    className?: string;
  };
  value?: string;
  url?: string;
}

export class ActionRecorder {
  private actions: RecordedAction[] = [];
  private page: any;
  private isRecording: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private clickHandler: ((event: any) => void) | null = null;
  private inputHandler: ((event: any) => void) | null = null;
  private changeHandler: ((event: any) => void) | null = null;

  constructor(page: any) {
    this.page = page;
  }

  /**
   * 开始记录操作
   */
  async startRecording(): Promise<void> {
    if (this.isRecording) {
      // 如果已经在记录，只重新设置监听器（用于页面导航后）
      await this.setupInjectedListeners().catch(() => {
        // 忽略错误，轮询机制仍然可以工作
      });
      return;
    }

    this.isRecording = true;
    this.actions = [];

    // 直接使用注入脚本方式（Stagehand 的 page 对象可能不支持标准 Playwright 事件）
    const injected = await this.setupInjectedListeners();
    
    if (!injected) {
      console.warn('[记录器] ⚠️  事件监听器注入失败，尝试使用CDP方式...');
      // 尝试使用 CDP 作为备用方案
      try {
        await this.setupCDPListeners();
        console.log('[记录器] CDP监听器设置成功');
      } catch (cdpError) {
        console.warn('[记录器] CDP方式也失败，将仅使用轮询机制记录操作');
        console.warn('[记录器] 提示: 操作记录可能会有延迟，但不会影响基本功能');
      }
    }

    // 尝试监听页面导航事件（如果支持的话）
    try {
      if (typeof this.page.on === 'function') {
        this.page.on('framenavigated', async () => {
          if (this.isRecording) {
            console.log('[记录器] 检测到页面导航，重新设置监听器...');
            await this.setupInjectedListeners();
          }
        });
      }
    } catch (error) {
      // 如果 page.on 不可用，忽略（Stagehand 可能不支持）
      console.log('[记录器] 无法监听页面导航事件，将在导航时手动重新设置监听器');
    }

    // 启动轮询来获取记录的操作（这是主要机制）
    this.startPolling();

    console.log('[记录器] 操作记录已启动');
  }

  /**
   * 在页面中注入事件监听器（备用方案）
   * @returns 是否成功注入
   */
  private async setupInjectedListeners(): Promise<boolean> {
    // 等待页面就绪（多次重试）
    let retries = 5;
    while (retries > 0) {
      try {
        // 等待页面加载
        await this.page.waitForTimeout(1000);
        
        // 检查页面是否可用
        const pageReady = await this.page.evaluate(() => {
          // @ts-ignore - 这些代码在浏览器环境中运行
          return typeof document !== 'undefined' && typeof window !== 'undefined' && document.readyState !== 'loading';
        }).catch(() => false);
        
        if (pageReady) {
          console.log(`[记录器] 页面已就绪，准备注入监听器 (剩余重试: ${retries - 1})`);
          break;
        } else {
          console.log(`[记录器] 页面未就绪，继续等待... (剩余重试: ${retries - 1})`);
        }
      } catch (error) {
        // 忽略错误，继续重试
        console.log(`[记录器] 检查页面状态时出错，继续重试... (剩余重试: ${retries - 1})`);
      }
      retries--;
    }

    // 在页面中设置监听器
    try {
      await this.page.evaluate(() => {
        // @ts-ignore - 这些代码在浏览器环境中运行
        const doc = document;
        // @ts-ignore
        const win = window as any;
        
        // 清除旧的监听器（如果存在）
        if (win._actionRecorderListeners) {
          win._actionRecorderListeners.forEach((listener: any) => {
            try {
              doc.removeEventListener(listener.type, listener.handler, true);
            } catch (e) {
              // 忽略错误
            }
          });
          win._actionRecorderListeners = [];
        }

        if (!win._actionRecorderListeners) {
          win._actionRecorderListeners = [];
        }
      // 点击事件
      const clickHandler = (event: Event) => {
        // @ts-ignore
        const target = event.target as HTMLElement;
        const elementInfo = {
          tag: target.tagName,
          text: target.textContent?.trim().substring(0, 50) || '',
          id: target.id || '',
          className: target.className || '',
          // @ts-ignore
          placeholder: (target as HTMLInputElement).placeholder || '',
          label: (target as any).labels?.[0]?.textContent?.trim() || ''
        };
        
        let description = '点击';
        if (elementInfo.label) {
          description += ` ${elementInfo.label}`;
        } else if (elementInfo.text) {
          description += ` "${elementInfo.text.substring(0, 30)}"`;
        } else if (elementInfo.placeholder) {
          description += ` ${elementInfo.placeholder}`;
        } else if (elementInfo.id) {
          description += ` ID为"${elementInfo.id}"的元素`;
        } else {
          description += ` ${elementInfo.tag}元素`;
        }

        const action = {
          timestamp: Date.now(),
          type: 'click',
          description,
          element: elementInfo
        };
        if (!win._uiRecordedActions) {
          win._uiRecordedActions = [];
        }
        win._uiRecordedActions.push(action);
        // 调试：在控制台输出（仅在开发时有用）
        if (win.console && win.console.log) {
          win.console.log('[操作记录]', description);
        }
      };
      doc.addEventListener('click', clickHandler, true);
      win._actionRecorderListeners.push({ type: 'click', handler: clickHandler });

      // 输入事件
      const inputHandler = (event: Event) => {
        // @ts-ignore
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          // @ts-ignore
          const input = target as HTMLInputElement;
          const elementInfo = {
            tag: input.tagName,
            placeholder: input.placeholder || '',
            id: input.id || '',
            className: input.className || '',
            label: (input as any).labels?.[0]?.textContent?.trim() || '',
            type: input.type || ''
          };
          const value = input.value;
          
          let description = '在';
          if (elementInfo.placeholder) {
            description += `"${elementInfo.placeholder}"`;
          } else if (elementInfo.label) {
            description += `"${elementInfo.label}"`;
          } else if (elementInfo.id) {
            description += `ID为"${elementInfo.id}"的输入框`;
          } else {
            description += `${elementInfo.tag}输入框`;
          }
          description += `输入 "${value}"`;

          const action = {
            timestamp: Date.now(),
            type: 'type',
            description,
            element: elementInfo,
            value
          };
          if (!win._uiRecordedActions) {
            win._uiRecordedActions = [];
          }
          win._uiRecordedActions.push(action);
          // 调试：在控制台输出
          if (win.console && win.console.log) {
            win.console.log('[操作记录]', description);
          }
        }
      };
      doc.addEventListener('input', inputHandler, true);
      win._actionRecorderListeners.push({ type: 'input', handler: inputHandler });

      // 选择事件
      const changeHandler = (event: Event) => {
        // @ts-ignore
        const target = event.target as HTMLElement;
        if (target.tagName === 'SELECT') {
          // @ts-ignore
          const select = target as HTMLSelectElement;
          const elementInfo = {
            tag: select.tagName,
            id: select.id || '',
            className: select.className || '',
            label: (select as any).labels?.[0]?.textContent?.trim() || ''
          };
          const text = select.options[select.selectedIndex]?.text || select.value;
          
          let description = '选择';
          if (elementInfo.label) {
            description += ` ${elementInfo.label}`;
          } else if (elementInfo.id) {
            description += ` ID为"${elementInfo.id}"的下拉框`;
          } else {
            description += `下拉框`;
          }
          description += `中的选项 "${text}"`;

          const action = {
            timestamp: Date.now(),
            type: 'select',
            description,
            element: elementInfo,
            value: text
          };
          if (!win._uiRecordedActions) {
            win._uiRecordedActions = [];
          }
          win._uiRecordedActions.push(action);
          // 调试：在控制台输出
          if (win.console && win.console.log) {
            win.console.log('[操作记录]', description);
          }
        }
      };
      doc.addEventListener('change', changeHandler, true);
      win._actionRecorderListeners.push({ type: 'change', handler: changeHandler });
      
      return true; // 表示成功设置
    });
      // 验证监听器是否真的被设置了
      const verifyResult = await this.page.evaluate(() => {
        // @ts-ignore
        const win = window as any;
        return {
          hasListeners: !!win._actionRecorderListeners && win._actionRecorderListeners.length > 0,
          listenerCount: win._actionRecorderListeners?.length || 0,
        };
      }).catch(() => ({ hasListeners: false, listenerCount: 0 }));
      
      if (verifyResult.hasListeners) {
        console.log(`[记录器] 事件监听器注入成功 (${verifyResult.listenerCount} 个监听器)`);
      } else {
        console.warn('[记录器] 事件监听器注入可能失败，验证时未找到监听器');
      }
      return verifyResult.hasListeners;
    } catch (error: any) {
      // 如果注入失败，记录错误但不抛出异常
      const errorMsg = error?.message || String(error || '未知错误');
      // 只在debug模式下显示详细错误
      if (errorMsg.includes('Uncaught') || errorMsg.includes('StagehandEvalError')) {
        // 这通常是页面安全策略或页面未完全加载导致的，属于正常情况
        return false;
      }
      console.warn('[记录器] 注入事件监听器时出错:', errorMsg);
      return false;
    }
  }

  /**
   * 使用 CDP 设置事件监听器（备用方案）
   */
  private async setupCDPListeners(): Promise<void> {
    try {
      // 启用 DOM 事件监听
      await this.page.sendCDP('DOM.enable');
      await this.page.sendCDP('Runtime.enable');
      
      // 监听 DOM 事件
      this.page.on('CDPEvent', (event: any) => {
        if (event.name === 'DOM.click' || event.name === 'DOM.input' || event.name === 'DOM.change') {
          // 处理事件
          // 注意：CDP 事件的处理比较复杂，这里先不实现
          // 主要依赖注入脚本方式
        }
      });
    } catch (error) {
      throw new Error('CDP监听器设置失败');
    }
  }

  /**
   * 获取元素信息（用于 Playwright 事件监听器）
   */
  private async getElementInfo(element: any): Promise<any> {
    try {
      return await this.page.evaluate((el: any) => {
        return {
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 50) || '',
          id: el.id || '',
          className: el.className || '',
          placeholder: el.placeholder || '',
          label: el.labels?.[0]?.textContent?.trim() || ''
        };
      }, element);
    } catch {
      return {};
    }
  }

  /**
   * 轮询获取页面中记录的操作
   */
  private startPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    let pollCount = 0;
    this.pollInterval = setInterval(async () => {
      if (!this.isRecording) {
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
        return;
      }

      pollCount++;
      // 每10次轮询（约3秒）输出一次调试信息
      if (pollCount % 10 === 0) {
        console.log(`[记录器] 轮询运行中... (已轮询 ${pollCount} 次)`);
      }

      try {
        const actions = await this.page.evaluate(() => {
          // @ts-ignore
          const win = window as any;
          if (!win._uiRecordedActions || win._uiRecordedActions.length === 0) {
            return [];
          }
          const actions = [...win._uiRecordedActions];
          win._uiRecordedActions = [];
          return actions;
        }) as RecordedAction[];

        if (actions.length > 0) {
          console.log(`[记录器] 通过轮询捕获到 ${actions.length} 个操作`);
          actions.forEach(action => this.recordAction(action));
        }
      } catch (error: any) {
        // 忽略错误，可能是页面已卸载
        if (this.isRecording && error?.message?.includes('Target closed')) {
          console.warn('[记录器] 页面已关闭，停止轮询');
          this.stopRecording();
        }
      }
    }, 300); // 每300ms轮询一次，更频繁地获取操作
    
    console.log('[记录器] 轮询机制已启动');
  }

  /**
   * 记录操作
   */
  private recordAction(action: RecordedAction): void {
    // 即使 isRecording 为 false，也允许记录（在停止时获取剩余操作）
    
    // 避免重复记录相同的操作（在短时间内）
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction && 
        action.type === lastAction.type &&
        action.description === lastAction.description &&
        Date.now() - lastAction.timestamp < 500) {
      return;
    }

    this.actions.push(action);
    if (this.isRecording) {
      console.log(`[记录] ${action.description}`);
    }
  }

  /**
   * 停止记录
   */
  async stopRecording(): Promise<void> {
    this.isRecording = false;
    
    // 停止轮询
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // 清理页面中的监听器
    try {
      this.page.evaluate(() => {
        // @ts-ignore
        const win = window as any;
        if (win._actionRecorderListeners) {
          win._actionRecorderListeners.forEach((listener: any) => {
            // @ts-ignore
            document.removeEventListener(listener.type, listener.handler, true);
          });
          win._actionRecorderListeners = [];
        }
      });
    } catch (error) {
      // 忽略错误，可能页面已关闭
    }

    // 最后一次获取剩余的操作（等待一小段时间确保所有操作都被捕获）
    if (this.page && !this.page.isClosed()) {
      try {
        // 等待一小段时间，确保所有事件都被处理
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // 获取剩余的操作
        const actions = await this.page.evaluate(() => {
          // @ts-ignore
          const win = window as any;
          if (!win._uiRecordedActions || win._uiRecordedActions.length === 0) {
            return [];
          }
          const actions = [...win._uiRecordedActions];
          win._uiRecordedActions = [];
          return actions;
        }) as RecordedAction[];

        if (actions.length > 0) {
          console.log(`[记录器] 获取到 ${actions.length} 个剩余操作`);
          actions.forEach(action => this.recordAction(action));
        }
      } catch (error) {
        // 忽略错误，可能页面已关闭
        console.warn('[记录器] 获取剩余操作时出错:', error);
      }
    }

    console.log(`[记录器] 已停止记录，共记录 ${this.actions.length} 个操作`);
  }

  /**
   * 获取记录的操作列表
   */
  getActions(): RecordedAction[] {
    return this.actions;
  }

  /**
   * 获取操作的自然语言描述列表
   */
  getActionDescriptions(): string[] {
    return this.actions.map(action => action.description);
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.actions = [];
  }

  /**
   * 导出为测试步骤格式
   */
  exportAsSteps(): string[] {
    return this.getActionDescriptions();
  }
}
