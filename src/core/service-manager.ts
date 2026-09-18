import { Notice, Platform } from 'obsidian';
import SemantixPlugin from '../main';
import { HealthStatus } from '../api/client';
import { getElectronNodeModule, getElectronProcess } from '../utils/node-adapter';

interface ProcessStream {
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

interface ManagedProcess {
    pid?: number;
    stdout: ProcessStream | null;
    stderr: ProcessStream | null;
    on(event: 'close', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    kill(signal?: string): boolean;
}

interface ExecSyncResult {
    toString(encoding?: string): string;
}

interface ChildProcessModule {
    spawn: (command: string, args: string[], options: Record<string, unknown>) => ManagedProcess;
    exec: (command: string, callback?: (error: Error | null, stdout: string, stderr: string) => void) => unknown;
    execSync: (command: string) => ExecSyncResult;
}

function getChildProcess(): ChildProcessModule | null {
    return getElectronNodeModule<ChildProcessModule>('child_process');
}

export class ServiceManager {
    private plugin: SemantixPlugin;
    private process: ManagedProcess | null = null;
    private isStarting: boolean = false;
    private onStatusCallback?: (msg: string) => void;

    // 自愈与熔断状态机 (Self-Healing & Circuit Breaker)
    private healAttempts: number = 0;
    private readonly maxHealAttempts: number = 3;
    private lastHealTimestamp: number = 0;
    private healTimer: number | null = null;
    private userIntentStopped: boolean = false;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
    }

    /**
     * 注册状态消费者
     */
    public setStatusConsumer(callback: (msg: string) => void) {
        this.onStatusCallback = callback;
    }

    private reportStatus(msg: string) {
        if (this.onStatusCallback) this.onStatusCallback(msg);
    }

    /**
     * 重置自愈计数器与用户主动停止标记
     */
    public resetHealing() {
        this.healAttempts = 0;
        this.userIntentStopped = false;
        this.cancelSelfHealing();
    }

    /**
     * 设置用户意图标记 (主动停止则禁止自愈)
     */
    public setUserIntentStopped(stopped: boolean) {
        this.userIntentStopped = stopped;
        if (stopped) {
            this.cancelSelfHealing();
        }
    }

    public isUserStopped(): boolean {
        return this.userIntentStopped;
    }

    private cancelSelfHealing() {
        if (this.healTimer !== null) {
            window.clearTimeout(this.healTimer);
            this.healTimer = null;
        }
    }

    /**
     * 触发自愈重启流程 (带指数退避与三振出局熔断保护)
     */
    public triggerSelfHealing(reason: string) {
        if (!Platform.isDesktop) return;
        if (this.userIntentStopped) return;
        const { settings } = this.plugin;
        if (settings.backendMode !== 'local' || !settings.autoStartServer) return;
        if (this.isStarting || this.isRunning()) return;
        if (this.healTimer !== null) return; // 已在等待退避调度中

        // 窗口滑动：距离上次自愈超过 2 分钟，自动清零失败计数
        if (Date.now() - this.lastHealTimestamp > 120_000) {
            this.healAttempts = 0;
        }

        // 熔断保护：连续失败达到 3 次，停止自动拉起，避免 CPU 飙升与死循环
        if (this.healAttempts >= this.maxHealAttempts) {
            this.reportStatus("后台服务连续异常退出，自愈机制已熔断暂停 🛑");
            new Notice("Semantix: 引擎连续多次异常退出，已暂停自动拉起。请检查环境或手动启动。");
            return;
        }

        this.healAttempts++;
        this.lastHealTimestamp = Date.now();

        // 指数退避调度: 1次 3s, 2次 6s, 3次 15s
        const backoffDelay = this.healAttempts === 1 ? 3000 : this.healAttempts === 2 ? 6000 : 15000;
        this.reportStatus(`服务异常 (${reason})，${backoffDelay / 1000}s 后尝试自动自愈 (${this.healAttempts}/${this.maxHealAttempts})...`);

        this.healTimer = window.setTimeout(() => {
            void (async () => {
                this.healTimer = null;
                if (this.userIntentStopped || this.isRunning() || this.isStarting) return;

                // 自愈前检查外部是否已恢复或手动拉起服务
                const status = await this.plugin.apiClient.checkFullHealth();
                if (status === HealthStatus.READY) {
                    this.onHealthyStable();
                    this.reportStatus("后端连接已恢复 ✅");
                    void this.plugin.checkConnection({ silent: true });
                    return;
                }
                if (status === HealthStatus.LOADING) {
                    this.reportStatus("后端正在载入模型，等待就绪... ⏳");
                    return;
                }

                await this.forceKillAndStart({ isHeal: true });
            })();
        }, backoffDelay);
    }

    /**
     * 外部通知连接恢复稳定，重置熔断计数
     */
    public onHealthyStable() {
        this.healAttempts = 0;
    }

    /**
     * 根据配置启动后端服务
     * @param options.force 是否忽略 autoStartServer 配置强制启动
     */
    public async start(options: { force?: boolean; isHeal?: boolean } = {}) {
        const { force = false, isHeal = false } = options;
        if (!Platform.isDesktop) return;
        
        // 如果进程已在运行，且不是为了修复重启，则直接跳过
        if (this.process && !force) return;
        if (this.isStarting) return;

        // 如果用户主动启动，清除停止标记并重置自愈
        if (!isHeal && force) {
            this.resetHealing();
        }

        // 在真正启动前，重置 UI 层的通知锁定状态
        this.plugin.resetStartupNotice();

        const { settings } = this.plugin;
        if (settings.backendMode !== 'local') return;
        
        // 如果不是强制启动且自启选项没开，则跳过
        if (!settings.autoStartServer && !force) return;

        if (!settings.backendPath || settings.backendPath.trim() === '') {
            if (force) new Notice("Semantix: 请先在设置中配置后端项目路径。");
            return;
        }

        this.isStarting = true;
        this.plugin.updateAllViewStatus('syncing');

        try {
            // 在真正尝试拉起进程前，无条件检查后端是否已经在外部正常运行（如用户手动启动）
            const status = await this.plugin.apiClient.checkFullHealth();
            if (status === HealthStatus.READY) {
                this.reportStatus("后端已在运行中 ✅");
                this.isStarting = false;
                this.onHealthyStable();
                void this.plugin.checkConnection({ silent: !force });
                return;
            }
            if (status === HealthStatus.LOADING) {
                this.reportStatus("后端正在载入模型... ⏳");
                this.isStarting = false;
                return;
            }

            const effectivePort = this.getEffectivePort();
            // 构造启动命令
            const args = settings.pythonPath === 'uv' 
                ? ['run', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', effectivePort.toString()]
                : ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', effectivePort.toString()];

            const electronProc = getElectronProcess();
            const parentPid = electronProc?.pid ? String(electronProc.pid) : '';
            const env: Record<string, string | undefined> = { 
                ...(electronProc?.env ?? {}), 
                SEMANTIX_PARENT_PID: parentPid 
            };

            const cp = getChildProcess();
            if (!cp) {
                this.reportStatus("当前环境不支持本地进程管理 ❌");
                this.isStarting = false;
                return;
            }

            this.reportStatus("正在唤醒后端服务...");
            // 安全：禁用 shell 模式防止 pythonPath 注入攻击
            // spawn 在非 shell 模式下原生支持含空格路径
            const proc = cp.spawn(settings.pythonPath, args, {
                cwd: settings.backendPath,
                shell: false,
                detached: false,
                env
            });
            this.process = proc;

            // 实时监听日志流
            proc.stdout?.on('data', (chunk: unknown) => {
                if (this.process !== proc) return; // 关键：丢弃非当前活跃进程的日志
                const line = String(chunk);
                if (line.includes("Model loaded")) {
                    this.reportStatus("模型加载完成 🧠");
                } else if (line.includes("Uvicorn running on")) {
                    this.reportStatus("服务已就绪 🚀");
                    // 只有当前进程成功触发时才执行一次健康检查更新
                    window.setTimeout(() => { void this.plugin.checkConnection({ silent: true }); }, 500);
                } else if (line.includes("Downloading:")) {
                    // 尝试提取下载进度
                    const match = line.match(/Downloading[:\s]+(\d+%)|(\d+\.?\d*[kM]B\/s)/);
                    if (match) {
                        this.reportStatus(`模型下载中: ${match[0] ?? ''}...`);
                    } else {
                        this.reportStatus("正在下载语义模型 (首次运行耗时较长)...");
                    }
                }
            });

            proc.stderr?.on('data', (chunk: unknown) => {
                if (this.process !== proc) return; 
                const line = String(chunk);
                // 识别一些常见的加载提示或错误
                if (line.includes("Loading model") || line.includes("Loading embedding model")) {
                    this.reportStatus("正在加载语义引擎 (约需 10-30s)...");
                } else if (line.includes("Downloading")) {
                    this.reportStatus("正在从 HuggingFace/ModelScope 下载模型数据...");
                } else if (line.includes("ERROR")) {
                    const firstLine = line.split('\n')[0] ?? '';
                    this.reportStatus(`出错了: ${firstLine.substring(0, 50)}...`);
                }
            });

            proc.on('close', (code) => {
                if (this.process !== proc) return; // 关键：如果是旧进程关闭，不影响状态位和 UI 通知
                
                this.process = null;
                this.isStarting = false;
                void this.plugin.checkConnection();
                if (code !== 0 && code !== null) {
                    this.reportStatus(`服务异常退出 (Code: ${code}) ❌`);
                    this.triggerSelfHealing(`进程意外退出 (Code: ${code})`);
                }
            });

            proc.on('error', (err: Error) => {
                if (this.process !== proc) return;
                this.reportStatus(`启动失败: ${err.message} ❌`);
                this.process = null;
                this.isStarting = false;
                this.triggerSelfHealing(`启动错误: ${err.message}`);
            });

            // 给予一定时间再检查状态
            window.setTimeout(() => { void this.plugin.checkConnection(); }, 3000);

        } catch {
            this.reportStatus("启动流程遭遇意外错误 ❌");
            this.isStarting = false;
            this.triggerSelfHealing("启动流程抛出未捕获异常");
        }
    }

    /**
     * 从设置项 backendUrl 中动态提取有效端口（默认 8000）
     */
    public getEffectivePort(): number {
        try {
            const parsed = new URL(this.plugin.settings.backendUrl || 'http://localhost:8000');
            if (parsed.port) return parseInt(parsed.port, 10);
            return parsed.protocol === 'https:' ? 443 : 80;
        } catch {
            return 8000;
        }
    }

    /**
     * 强力清理并重新启动 (支持自愈模式透传)
     */
    public async forceKillAndStart(options: { isHeal?: boolean } = {}) {
        const port = this.getEffectivePort();
        this.reportStatus(options.isHeal ? "正在自愈重启引擎..." : `正在清理 ${port} 端口并重新尝试手动启动...`);
        await this.killPortConflict();
        // 给系统一点释放资源的时间
        await new Promise(r => window.setTimeout(r, 1000));
        await this.start({ force: true, isHeal: options.isHeal });
    }

    /**
     * 扫描并结束目标端口上的非本插件进程 (优先使用 PID 锁文件精准回收)
     */
    private async killPortConflict(): Promise<void> {
        return new Promise((resolve) => {
            const cp = getChildProcess();
            if (!cp) { resolve(); return; }

            // 1. 优先尝试读取并回收 .semantix.pid
            try {
                // 动态获取 Electron/Node fs 和 path 模块
                const fs = getElectronNodeModule<{ existsSync: (p: string) => boolean; readFileSync: (p: string, enc: string) => string; unlinkSync: (p: string) => void }>('fs');
                const pathMod = getElectronNodeModule<{ join: (...args: string[]) => string }>('path');
                if (fs && pathMod && this.plugin.settings.backendPath) {
                    const pidFile = pathMod.join(this.plugin.settings.backendPath, '.semantix.pid');
                    if (fs.existsSync(pidFile)) {
                        const content = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as { pid?: string | number };
                        const orphanPid = String(content?.pid ?? '');
                        // 安全校验：PID 必须为纯数字，防止命令注入
                        if (orphanPid && /^\d+$/.test(orphanPid)) {
                            // 进程所有权核验：确保该 PID 确实对应我们的服务，防止 PID 复用击杀无关进程
                            let isOwnedProcess = false;
                            const backendKey = this.plugin.settings.backendPath.split(/[\\/]/).pop() || "engine";
                            try {
                                if (Platform.isWin) {
                                    const cmdInfo = cp.execSync(`wmic process where processid=${orphanPid} get commandline`).toString();
                                    if (cmdInfo.includes("main:app") && (cmdInfo.includes(backendKey) || cmdInfo.includes("uv") || cmdInfo.includes("semantix"))) {
                                        isOwnedProcess = true;
                                    }
                                } else {
                                    const cmdLine = cp.execSync(`ps -p ${orphanPid} -o args=`).toString();
                                    if (cmdLine.includes("main:app") && (cmdLine.includes(backendKey) || cmdLine.includes("uv") || cmdLine.includes("semantix"))) {
                                        isOwnedProcess = true;
                                    }
                                }
                            } catch {
                                // 进程可能已经不存在
                                isOwnedProcess = false;
                            }

                            if (isOwnedProcess) {
                                if (Platform.isWin) {
                                    cp.execSync(`taskkill /F /T /PID "${orphanPid}"`);
                                } else {
                                    cp.execSync(`kill -9 ${orphanPid}`);
                                }
                                this.reportStatus(`已验证所有权并回收孤儿进程 (${orphanPid})`);
                            } else {
                                console.warn(`[Semantix] Stale PID file found (${orphanPid}) but process does not match Semantix. Skipping kill.`);
                            }
                        } else if (orphanPid) {
                            console.warn('[Semantix] Invalid PID format in .semantix.pid, skipping kill:', orphanPid);
                        }
                        fs.unlinkSync(pidFile);
                    }
                }
            } catch {
                // 忽略锁文件回收中的异常，继续执行端口扫描降级兜底
            }

            // 2. 降级方案：端口占用探测与清理
            const port = this.getEffectivePort();
            if (Platform.isWin) {
                // Windows 实现
                cp.exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
                    if (error || !stdout) { resolve(); return; }
                    const lines = stdout.split('\n');
                    const pids = new Set<string>();
                    lines.forEach((line: string) => {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && !isNaN(parseInt(pid)) && pid !== '0') pids.add(pid);
                    });
                    if (pids.size === 0) { resolve(); return; }

                    const targetPids: string[] = [];
                    const backendPathKey = this.plugin.settings.backendPath.split(/[\\/]/).pop() || "";
                    
                    try {
                        for (const pid of pids) {
                            const cmdInfo = cp.execSync(`wmic process where processid=${pid} get commandline`).toString();
                            if (cmdInfo.includes("main:app") && (cmdInfo.includes(backendPathKey) || cmdInfo.includes("uv"))) {
                                targetPids.push(pid);
                            }
                        }
                    } catch { /* ignore */ }

                    if (targetPids.length === 0) { resolve(); return; }
                    const pidStr = targetPids.join(' /PID ');
                    cp.exec(`taskkill /F /PID ${pidStr}`, () => resolve());
                });
            } else {
                // Unix (macOS/Linux) 实现
                cp.exec(`lsof -t -i :${port}`, (error, stdout) => {
                    if (error || !stdout) { resolve(); return; }
                    
                    const pids = stdout.trim().split('\n');
                    const targetPids: string[] = [];
                    const backendPathKey = this.plugin.settings.backendPath.split(/[\\/]/).pop() || "";

                    pids.forEach((pid: string) => {
                        try {
                            const cmdLine = cp.execSync(`ps -p ${pid} -o args=`).toString();
                            if (cmdLine.includes("main:app") && (cmdLine.includes(backendPathKey) || cmdLine.includes("uv"))) {
                                targetPids.push(pid);
                            }
                        } catch { /* ignore */ }
                    });

                    if (targetPids.length === 0) { resolve(); return; }

                    cp.exec(`kill -9 ${targetPids.join(' ')}`, () => {
                        this.reportStatus("已清理旧的后端进程");
                        resolve();
                    });
                });
            }
        });
    }

    /**
     * 停止后端服务并回收资源 (Obsidian 退出或卸载插件时调用)
     */
    public stop() {
        if (!Platform.isDesktop) return;

        // 停止任何正在排队的自愈定时器
        this.cancelSelfHealing();

        if (this.process && this.process.pid) {
            const targetPid = this.process.pid;
            this.reportStatus("正在停止服务并回收资源...");
            const cp = getChildProcess();
            
            if (Platform.isWin) {
                // Windows 下必须使用 taskkill /T (Tree) 才能杀死通过 shell 启动的子进程
                // 使用 execSync 确保在插件 onunload 完成前同步结束进程
                try {
                    // 对 PID 使用引号包裹增加安全性
                    if (cp) cp.execSync(`taskkill /F /T /PID "${targetPid}"`);
                } catch {
                    // 忽略进程可能已经自行退出的报错
                }
            } else {
                this.process.kill('SIGTERM');
            }
            
            this.process = null;
        }

        // 清理 PID 锁文件
        try {
            const fs = getElectronNodeModule<{ existsSync: (p: string) => boolean; unlinkSync: (p: string) => void }>('fs');
            const pathMod = getElectronNodeModule<{ join: (...args: string[]) => string }>('path');
            if (fs && pathMod && this.plugin.settings.backendPath) {
                const pidFile = pathMod.join(this.plugin.settings.backendPath, '.semantix.pid');
                if (fs.existsSync(pidFile)) {
                    fs.unlinkSync(pidFile);
                }
            }
        } catch {
            // 忽略文件移除异常
        }
    }

    public isRunning(): boolean {
        return this.process !== null;
    }

    /**
     * 判断是否正在处理启动流程
     */
    public isActivating(): boolean {
        return (this.isStarting || this.isRunning()) && Platform.isDesktop;
    }
}

