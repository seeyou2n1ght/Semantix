import { Platform } from 'obsidian';

/**
 * 安全获取 Electron / Node.js 原生模块
 * 在移动端 (iOS/Android) 环境下直接返回 null，防止触发 CommonJS 加载异常
 */
interface WindowNode {
    require?: (moduleName: string) => unknown;
}

export function getElectronNodeModule<T = unknown>(moduleName: string): T | null {
    if (!Platform.isDesktop) {
        return null;
    }

    try {
        const win = window as unknown as WindowNode;
        const glob = globalThis as unknown as WindowNode;
        const req = win.require || glob.require;
        if (typeof req === 'function') {
            return req(moduleName) as T;
        }
    } catch {
        return null;
    }

    return null;
}
