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

interface PortProbeServer {
    once(event: 'error', listener: (error: unknown) => void): unknown;
    listen(port: number, host: string, listener: () => void): unknown;
    address(): { port: number } | string | null;
    close(callback: (error?: Error) => void): unknown;
}

interface NetModule {
    createServer(): PortProbeServer;
}

interface ChildProcessModule {
    spawn: (command: string, args: string[], options: Record<string, unknown>) => ManagedProcess;
    execFileSync: (file: string, args: string[], options: { shell: false; windowsHide: boolean }) => unknown;
}

function getChildProcess(): ChildProcessModule | null {
    return getElectronNodeModule<ChildProcessModule>('child_process');
}

export class ServiceManager {
    private plugin: SemantixPlugin;
    private process: ManagedProcess | null = null;
    private isStarting: boolean = false;
    private startGeneration = 0;
    private onStatusCallback?: (msg: string) => void;
    private lastStatus = '';

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
        this.lastStatus = msg;
        if (this.onStatusCallback) this.onStatusCallback(msg);
    }

    public getLastStatus(): string { return this.lastStatus; }

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
        this.lastStatus = '后端已就绪 ✅';
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
        const generation = ++this.startGeneration;
        this.plugin.updateAllViewStatus('syncing');

        try {
            // 在真正尝试拉起进程前，无条件检查后端是否已经在外部正常运行（如用户手动启动）
            const status = await this.plugin.apiClient.checkFullHealth();
            if (generation !== this.startGeneration) return;
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

            let effectivePort = this.getEffectivePort();
            const net = getElectronNodeModule<NetModule>('net');
            if (net) {
                const probe = (port: number) => new Promise<number>((resolve, reject) => {
                    const server = net.createServer();
                    server.once('error', reject);
                    server.listen(port, '127.0.0.1', () => {
                        const address = server.address();
                        server.close(error => {
                            if (error) reject(error);
                            else resolve(typeof address === 'object' && address ? address.port : port);
                        });
                    });
                });
                try {
                    await probe(effectivePort);
                } catch (error) {
                    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
                    effectivePort = await probe(0);
                    settings.backendUrl = `http://127.0.0.1:${effectivePort}`;
                    await this.plugin.saveSettings();
                    this.reportStatus(`默认端口被占用，改用 ${effectivePort} 端口`);
                }
            }
            if (generation !== this.startGeneration) return;
            // 构造启动命令
            const fs = getElectronNodeModule<{ existsSync: (path: string) => boolean }>('fs');
            const path = getElectronNodeModule<{ join: (...parts: string[]) => string }>('path');
            const venvPython = path?.join(settings.backendPath, '.venv', Platform.isWin ? 'Scripts' : 'bin', Platform.isWin ? 'python.exe' : 'python');
            const command = settings.pythonPath === 'uv' && venvPython && fs?.existsSync(venvPython)
                ? venvPython : settings.pythonPath;
            const args = command === 'uv'
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
            const proc = cp.spawn(command, args, {
                cwd: settings.backendPath,
                shell: false,
                windowsHide: true,
                detached: !Platform.isWin,
                env
            });
            this.process = proc;
            let lastStderr = '';

            // 实时监听日志流
            proc.stdout?.on('data', (chunk: unknown) => {
                if (this.process !== proc) return; // 关键：丢弃非当前活跃进程的日志
                const line = String(chunk);
                if (line.includes("Model loaded")) {
                    this.reportStatus("模型加载完成 🧠");
                } else if (line.includes("Uvicorn running on")) {
                    this.reportStatus("HTTP 服务已启动，等待模型就绪...");
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
                lastStderr = line.trim().split(/\r?\n/).filter(Boolean).pop() || lastStderr;
                if (line.includes("Uvicorn running on")) {
                    this.reportStatus("HTTP 服务已启动，等待模型就绪...");
                    window.setTimeout(() => { void this.plugin.checkConnection({ silent: true }); }, 500);
                }
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
                    this.reportStatus(`服务异常退出 (Code: ${code})${lastStderr ? `: ${lastStderr.slice(0, 160)}` : ''} ❌`);
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

        } catch (error) {
            this.reportStatus(`启动失败: ${error instanceof Error ? error.message : String(error)} ❌`);
            this.isStarting = false;
            this.triggerSelfHealing("启动流程抛出异常");
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
        this.reportStatus(options.isHeal ? "正在自愈重启引擎..." : `正在重新启动 ${port} 端口上的受管引擎...`);
        this.stop();
        // 给系统一点释放资源的时间
        await new Promise(r => window.setTimeout(r, 1000));
        await this.start({ force: true, isHeal: options.isHeal });
    }

    /**
     * 停止后端服务并回收资源 (Obsidian 退出或卸载插件时调用)
     */
    public stop() {
        if (!Platform.isDesktop) return;

        // 停止任何正在排队的自愈定时器
        this.startGeneration++;
        this.isStarting = false;
        this.cancelSelfHealing();

        const targetPid = this.process?.pid;
        if (this.process && targetPid) {
            this.reportStatus("正在停止服务并回收资源...");
            const cp = getChildProcess();
            
            if (Platform.isWin) {
                // Stop the owned process tree synchronously before plugin unload.
                try {
                    if (cp) cp.execFileSync('taskkill', ['/F', '/T', '/PID', String(targetPid)], {
                        shell: false,
                        windowsHide: true
                    });
                } catch {
                    // 忽略进程可能已经自行退出的报错
                }
            } else {
                try {
                    const nodeProcess = getElectronNodeModule<{ kill: (pid: number, signal: string) => void }>('process');
                    if (!nodeProcess) throw new Error('Node process module unavailable');
                    nodeProcess.kill(-targetPid, 'SIGTERM');
                } catch {
                    this.process.kill('SIGTERM');
                }
            }
            
            this.process = null;
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

