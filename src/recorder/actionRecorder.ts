/**
 * 操作记录器 - 记录用户操作并生成可供 stagehand.act / Playwright 回放用的 ActionJson（selector, method, arguments）
 */

import type { ActionJson } from '../data/dataStore.js';

/** 在浏览器中执行的监听器注入脚本（纯字符串，避免 tsx 序列化时注入 __name 等导致 ReferenceError） */
const RECORDER_EVALUATE_SCRIPT = `
(function() {
  var doc = document;
  var win = window;
  if (!win) return false;
  function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && typeof document !== 'undefined') {
      try {
        var idEsc = String(el.id).replace(/'/g, "''");
        if (document.evaluate("count(//*[@id='" + idEsc + "'])", document, null, 1, null).numberValue === 1)
          return "//*[@id='" + idEsc + "']";
      } catch (e) {}
    }
    var parts = [];
    var current = el;
    while (current && current.nodeType === 1) {
      var tag = current.tagName.toLowerCase();
      var idx = 1;
      var sib = current.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName && sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousSibling;
      }
      parts.unshift(tag + '[' + idx + ']');
      current = current.parentNode;
    }
    return '//' + (parts.length ? parts.join('/') : '*');
  }
  function getSelector(el) {
    var xpath = getXPath(el);
    return xpath ? 'xpath=' + xpath : '';
  }
  if (win._actionRecorderListeners) {
    win._actionRecorderListeners.forEach(function(l) {
      try { doc.removeEventListener(l.type, l.handler, true); } catch (e) {}
    });
    win._actionRecorderListeners = [];
  }
  win._actionRecorderListeners = win._actionRecorderListeners || [];
  win._uiRecordedActions = win._uiRecordedActions || [];
  win._inputPending = win._inputPending || {};
  var INPUT_DEBOUNCE_MS = 600;
  function clickHandler(ev) {
    var target = ev.target || ev.srcElement;
    if (!target) return;
    var isCheckbox = target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio');
    var method = isCheckbox ? 'check' : 'click';
    var el = { tag: target.tagName, text: (target.textContent || '').trim().substring(0, 50) || '', id: target.id || '', className: target.className || '', placeholder: target.placeholder || '', label: (target.labels && target.labels[0] ? target.labels[0].textContent.trim() : '') || '' };
    var desc = isCheckbox ? '勾选' : '点击';
    if (el.label) desc += ' ' + el.label;
    else if (el.text) desc += ' "' + el.text.substring(0, 30) + '"';
    else if (el.placeholder) desc += ' ' + el.placeholder;
    else if (el.id) desc += ' ID为"' + el.id + '"的元素';
    else desc += ' ' + el.tag + '元素';
    var sel = getSelector(target);
    win._uiRecordedActions.push({ timestamp: Date.now(), type: 'click', description: desc, element: el, selector: sel || undefined, method: method, arguments: [] });
  }
  function inputHandler(ev) {
    var target = ev.target || ev.srcElement;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
    if (target.type === 'checkbox' || target.type === 'radio') return;
    var sel = getSelector(target) || 'input:' + Date.now();
    if (win._inputPending[sel]) clearTimeout(win._inputPending[sel].timer);
    win._inputPending[sel] = {
      target: target,
      timer: setTimeout(function() { flushInputPending(sel); }, INPUT_DEBOUNCE_MS)
    };
  }
  function flushInputPending(sel) {
    var p = win._inputPending[sel];
    if (!p || !p.target) return;
    clearTimeout(p.timer);
    var t = p.target;
    var el = { tag: t.tagName, placeholder: t.placeholder || '', id: t.id || '', className: t.className || '', label: (t.labels && t.labels[0] ? t.labels[0].textContent.trim() : '') || '', type: t.type || '' };
    var value = t.value;
    var desc = '在';
    if (el.placeholder) desc += '"' + el.placeholder + '"';
    else if (el.label) desc += '"' + el.label + '"';
    else if (el.id) desc += 'ID为"' + el.id + '"的输入框';
    else desc += el.tag + '输入框';
    desc += '输入 "' + (value || '') + '"';
    var s = getSelector(t) || sel;
    win._uiRecordedActions.push({ timestamp: Date.now(), type: 'type', description: desc, element: el, value: value, selector: s, method: 'fill', arguments: [value != null ? String(value) : ''] });
    delete win._inputPending[sel];
  }
  function blurHandler(ev) {
    var target = ev.target || ev.srcElement;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
    var sel = getSelector(target);
    if (sel && win._inputPending[sel]) flushInputPending(sel);
  }
  function changeHandler(ev) {
    var target = ev.target || ev.srcElement;
    if (!target || target.tagName !== 'SELECT') return;
    var el = { tag: target.tagName, id: target.id || '', className: target.className || '', label: (target.labels && target.labels[0] ? target.labels[0].textContent.trim() : '') || '' };
    var text = target.options && target.options[target.selectedIndex] ? target.options[target.selectedIndex].text : target.value;
    var optionValue = (target.options && target.options[target.selectedIndex]) ? target.options[target.selectedIndex].value : target.value;
    var desc = '选择';
    if (el.label) desc += ' ' + el.label;
    else if (el.id) desc += ' ID为"' + el.id + '"的下拉框';
    else desc += '下拉框';
    desc += '中的选项 "' + (text || '') + '"';
    var sel = getSelector(target);
    win._uiRecordedActions.push({ timestamp: Date.now(), type: 'select', description: desc, element: el, value: text, selector: sel || undefined, method: 'select', arguments: [optionValue != null ? String(optionValue) : ''] });
  }
  doc.addEventListener('click', clickHandler, true);
  win._actionRecorderListeners.push({ type: 'click', handler: clickHandler });
  doc.addEventListener('input', inputHandler, true);
  win._actionRecorderListeners.push({ type: 'input', handler: inputHandler });
  doc.addEventListener('blur', blurHandler, true);
  win._actionRecorderListeners.push({ type: 'blur', handler: blurHandler });
  doc.addEventListener('change', changeHandler, true);
  win._actionRecorderListeners.push({ type: 'change', handler: changeHandler });
  return true;
})();
`;

/** 供 addInitScript 使用的监听器注入脚本（在页面加载时自动执行，避免 evaluate 受 CSP 等限制） */
export function getRecorderInitScript(): () => void {
  return function recorderInitScript() {
    const doc = document;
    const win = window as any;
    /** 根据 DOM 元素生成 XPath，供 Playwright locator('xpath=...') 使用 */
    const getXPath = (el: any): string => {
      if (!el || el.nodeType !== 1) return '';
      if (el.id && typeof document !== 'undefined') {
        try {
          const idEsc = String(el.id).replace(/'/g, "''");
          const result = document.evaluate("count(//*[@id='" + idEsc + "'])", document, null, 1, null) as XPathResult;
          if (result.numberValue === 1) return "//*[@id='" + idEsc + "']";
        } catch (_) {}
      }
      const parts: string[] = [];
      let current: any = el;
      while (current && current.nodeType === 1) {
        const tag = current.tagName.toLowerCase();
        let idx = 1;
        let sib = current.previousSibling;
        while (sib) {
          if (sib.nodeType === 1 && sib.tagName && sib.tagName.toLowerCase() === tag) idx++;
          sib = sib.previousSibling;
        }
        parts.unshift(tag + '[' + idx + ']');
        current = current.parentNode;
      }
      return '//' + (parts.length ? parts.join('/') : '*');
    };
    const getSelector = (el: any): string => {
      const xpath = getXPath(el);
      return xpath ? 'xpath=' + xpath : '';
    };

    const INPUT_DEBOUNCE_MS = 600;
    const pending = ((win as any)._inputPending = (win as any)._inputPending || {}) as Record<string, { target: any; timer: ReturnType<typeof setTimeout> }>;

    function setup() {
      if (win._actionRecorderListeners) {
        win._actionRecorderListeners.forEach((l: { type: string; handler: (e: Event) => void }) => {
          try { doc.removeEventListener(l.type, l.handler, true); } catch (_) {}
        });
        win._actionRecorderListeners = [];
      }
      win._actionRecorderListeners = win._actionRecorderListeners || [];
      win._uiRecordedActions = win._uiRecordedActions || [];

      const clickHandler = (event: Event) => {
        const target = (event.target || event.srcElement) as any;
        if (!target) return;
        const isCheckbox = target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio');
        const method = isCheckbox ? 'check' : 'click';
        const el = {
          tag: target.tagName,
          text: (target.textContent || '').trim().substring(0, 50) || '',
          id: target.id || '',
          className: target.className || '',
          placeholder: target.placeholder || '',
          label: (target.labels && target.labels[0] ? target.labels[0].textContent?.trim() : '') || ''
        };
        let desc = isCheckbox ? '勾选' : '点击';
        if (el.label) desc += ' ' + el.label;
        else if (el.text) desc += ' "' + el.text.substring(0, 30) + '"';
        else if (el.placeholder) desc += ' ' + el.placeholder;
        else if (el.id) desc += ' ID为"' + el.id + '"的元素';
        else desc += ' ' + el.tag + '元素';
        const selector = getSelector(target);
        win._uiRecordedActions.push({
          timestamp: Date.now(),
          type: 'click',
          description: desc,
          element: el,
          selector: selector || undefined,
          method,
          arguments: []
        });
      };
      doc.addEventListener('click', clickHandler, true);
      win._actionRecorderListeners.push({ type: 'click', handler: clickHandler });

      const inputHandler = (event: Event) => {
        const target = (event.target || event.srcElement) as any;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
        if (target.type === 'checkbox' || target.type === 'radio') return;
        const sel = getSelector(target) || 'input:' + Date.now();
        if (pending[sel]) clearTimeout(pending[sel].timer);
        pending[sel] = {
          target,
          timer: setTimeout(() => {
            const p = pending[sel];
            if (!p || !p.target) return;
            const t = p.target;
            const elementInfo = {
              tag: t.tagName,
              placeholder: t.placeholder || '',
              id: t.id || '',
              className: t.className || '',
              label: (t.labels && t.labels[0] ? t.labels[0].textContent?.trim() : '') || '',
              type: t.type || ''
            };
            const value = t.value;
            let desc = '在';
            if (elementInfo.placeholder) desc += '"' + elementInfo.placeholder + '"';
            else if (elementInfo.label) desc += '"' + elementInfo.label + '"';
            else if (elementInfo.id) desc += 'ID为"' + elementInfo.id + '"的输入框';
            else desc += elementInfo.tag + '输入框';
            desc += '输入 "' + (value || '') + '"';
            const selector = getSelector(t) || sel;
            win._uiRecordedActions.push({
              timestamp: Date.now(),
              type: 'type',
              description: desc,
              element: elementInfo,
              value,
              selector: selector || undefined,
              method: 'fill',
              arguments: [value != null ? String(value) : '']
            });
            delete pending[sel];
          }, INPUT_DEBOUNCE_MS)
        };
      };
      const flushInputPending = (selector: string) => {
        const p = pending[selector];
        if (!p || !p.target) return;
        clearTimeout(p.timer);
        const t = p.target;
        const elementInfo = { tag: t.tagName, placeholder: t.placeholder || '', id: t.id || '', className: t.className || '', label: (t.labels && t.labels[0] ? t.labels[0].textContent?.trim() : '') || '', type: t.type || '' };
        const value = t.value;
        let desc = '在';
        if (elementInfo.placeholder) desc += '"' + elementInfo.placeholder + '"';
        else if (elementInfo.label) desc += '"' + elementInfo.label + '"';
        else if (elementInfo.id) desc += 'ID为"' + elementInfo.id + '"的输入框';
        else desc += elementInfo.tag + '输入框';
        desc += '输入 "' + (value || '') + '"';
        const s = getSelector(t) || selector;
        win._uiRecordedActions.push({ timestamp: Date.now(), type: 'type', description: desc, element: elementInfo, value, selector: s || undefined, method: 'fill', arguments: [value != null ? String(value) : ''] });
        delete pending[selector];
      };
      const blurHandler = (event: Event) => {
        const target = (event.target || event.srcElement) as any;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
        const selector = getSelector(target);
        if (selector && pending[selector]) flushInputPending(selector);
      };
      doc.addEventListener('input', inputHandler, true);
      win._actionRecorderListeners.push({ type: 'input', handler: inputHandler });
      doc.addEventListener('blur', blurHandler, true);
      win._actionRecorderListeners.push({ type: 'blur', handler: blurHandler });

      const changeHandler = (event: Event) => {
        const target = (event.target || event.srcElement) as any;
        if (!target || target.tagName !== 'SELECT') return;
        const el = {
          tag: target.tagName,
          id: target.id || '',
          className: target.className || '',
          label: (target.labels && target.labels[0] ? target.labels[0].textContent?.trim() : '') || ''
        };
        const text = (target.options && target.options[target.selectedIndex])
          ? target.options[target.selectedIndex].text
          : target.value;
        const optionValue = (target.options && target.options[target.selectedIndex])
          ? (target.options[target.selectedIndex] as any).value
          : target.value;
        let desc = '选择';
        if (el.label) desc += ' ' + el.label;
        else if (el.id) desc += ' ID为"' + el.id + '"的下拉框';
        else desc += '下拉框';
        desc += '中的选项 "' + (text || '') + '"';
        const selector = getSelector(target);
        win._uiRecordedActions.push({
          timestamp: Date.now(),
          type: 'select',
          description: desc,
          element: el,
          value: text,
          selector: selector || undefined,
          method: 'select',
          arguments: [optionValue != null ? String(optionValue) : '']
        });
      };
      doc.addEventListener('change', changeHandler, true);
      win._actionRecorderListeners.push({ type: 'change', handler: changeHandler });
    }
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', setup);
    } else {
      setup();
    }
  };
}

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
  /** 供 stagehand.act / Playwright 回放用 */
  selector?: string;
  method?: string;
  arguments?: string[];
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
      try {
        await this.setupCDPListeners();
      } catch {
        // CDP 不可用时忽略
      }
      // 无论注入/CDP 是否成功，轮询都会从 window._uiRecordedActions 拉取（init 脚本会在导航后写入）
      console.log('[记录器] 将使用轮询机制记录操作');
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
    // 若 addInitScript 已注入监听器，直接视为成功
    try {
      const alreadySet = await this.page.evaluate(() => {
        const w = typeof window !== 'undefined' ? (window as any) : null;
        return !!(w && w._actionRecorderListeners && w._actionRecorderListeners.length > 0);
      });
      if (alreadySet) {
        return true;
      }
    } catch {
      // 忽略，继续走注入流程
    }
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

    // 使用纯字符串脚本注入，避免 tsx 序列化时注入 __name 导致 ReferenceError
    try {
      await this.page.evaluate(
        (script: string) => (new Function(script))(),
        RECORDER_EVALUATE_SCRIPT
      );
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
   * 使用 CDP 连接（备用方案，仅建立连接便于后续扩展；实际记录仍依赖注入脚本或轮询）
   */
  private async setupCDPListeners(): Promise<void> {
    try {
      const ctx = typeof this.page.context === 'function' ? this.page.context() : null;
      if (!ctx || typeof ctx.newCDPSession !== 'function') {
        throw new Error('当前 page 不支持 CDP');
      }
      const cdp = await ctx.newCDPSession(this.page);
      await cdp.send('DOM.enable');
      await cdp.send('Runtime.enable');
      // CDP 仅作连接验证，事件记录仍依赖注入脚本
      return;
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
   * 仅停止轮询、不再记录（不访问 page，避免 Ctrl+C 时挂起）。
   * 用于 stop() 流程中先停轮询再保存文件。
   */
  stopRecordingSync(): void {
    this.isRecording = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * 停止记录（含清理页面监听器、拉取剩余操作；可能因 page.evaluate 挂起）
   */
  async stopRecording(): Promise<void> {
    this.stopRecordingSync();

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
   * 获取可供 stagehand.act / executeActionWithPlaywright 回放用的 ActionJson 列表
   */
  getActionsForAct(): ActionJson[] {
    return this.actions
      .map((a): ActionJson => {
        return {
          selector: a.selector || '',
          description: a.description,
          method: a.method || (a.type === 'type' ? 'type' : a.type === 'select' ? 'select' : 'click'),
          arguments: Array.isArray(a.arguments) ? a.arguments : (a.value != null ? [String(a.value)] : [])
        };
      })
      .filter(a => a.selector.length > 0);
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
