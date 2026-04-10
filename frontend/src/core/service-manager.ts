import { Notice, Platform } from 'obsidian';
import SemantixPlugin from '../main';
import { spawn, ChildProcess, exec, execSync } from 'child_process';
import * as path from 'path';
import { HealthStatus } from '../api/client';
import { t } from '../i18n/helpers';

export class ServiceManager {
    private plugin: SemantixPlugin;
    private process: ChildProcess | null = null;
    private isStarting: boolean = false;
    private onStatusCallback?: (msg: string) => void;

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
        console.log(`[Semantix Service]: ${msg}`);
    }

    /**
     * 根据配置启动后端服务
     * @param options.force 是否忽略 autoStartServer 配置强制启动
     */
    public async start(options: { force?: boolean } = {}) {
        const { force = false } = options;
        if (!Platform.isDesktop) return;
        
        // 如果进程已在运行，且不是为了修复重启，则直接跳过
        if (this.process && !force) return;
        if (this.isStarting) return;

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
            // 在启动前执行一次最终冲突检查
            if (force) {
                const status = await this.plugin.apiClient.checkFullHealth();
                if (status === HealthStatus.READY) {
                    this.reportStatus("后端已在运行中 ✅");
                    this.isStarting = false;
                    this.plugin.checkConnection();
                    return;
                }
            }

            // 1. (可选) 执行 uv sync
            if (settings.uvSyncOnStart && settings.pythonPath === 'uv') {
                this.reportStatus("正在同步后端依赖 (uv sync)...");
                await this.runSync();
            }

            // 2. 构造启动命令
            const args = settings.pythonPath === 'uv' 
                ? ['run', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000']
                : ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'];

            const env = { 
                ...process.env, 
                SEMANTIX_PARENT_PID: process.pid.toString() 
            };

            this.reportStatus("正在唤醒后端服务...");
            // 为路径包含空格的情况加固
            const proc = spawn(`"${settings.pythonPath}"`, args, {
                cwd: settings.backendPath,
                shell: true, // 在 Windows 下 spawn 字符串命令需要 shell
                detached: false,
                env
            });
            this.process = proc;

            // 实时监听日志流
            proc.stdout?.on('data', (data) => {
                if (this.process !== proc) return; // 关键：丢弃非当前活跃进程的日志
                const line = data.toString();
                if (line.includes("Model loaded")) {
                    this.reportStatus("模型加载完成 🧠");
                } else if (line.includes("Uvicorn running on")) {
                    this.reportStatus("服务已就绪 🚀");
                    // 只有当前进程成功触发时才执行一次健康检查更新
                    setTimeout(() => this.plugin.checkConnection({ silent: true }), 500);
                } else if (line.includes("Downloading:")) {
                    // 尝试提取下载进度
                    const match = line.match(/Downloading[:\s]+(\d+%)|(\d+\.?\d*[kM]B\/s)/);
                    if (match) {
                        this.reportStatus(`模型下载中: ${match[0]}...`);
                    } else {
                        this.reportStatus("正在下载语义模型 (首次运行耗时较长)...");
                    }
                }
            });

            proc.stderr?.on('data', (data) => {
                if (this.process !== proc) return; 
                const line = data.toString();
                // 识别一些常见的加载提示或错误
                if (line.includes("Loading model") || line.includes("Loading embedding model")) {
                    this.reportStatus("正在加载语义引擎 (约需 10-30s)...");
                } else if (line.includes("Downloading")) {
                    this.reportStatus("正在从 HuggingFace/ModelScope 下载模型数据...");
                } else if (line.includes("ERROR")) {
                    this.reportStatus(`出错了: ${line.split('\n')[0].substring(0, 50)}...`);
                }
            });

            proc.on('close', (code) => {
                if (this.process !== proc) return; // 关键：如果是旧进程关闭，不影响状态位和 UI 通知
                
                this.process = null;
                this.isStarting = false;
                this.plugin.checkConnection();
                if (code !== 0 && code !== null) {
                    this.reportStatus(`服务异常退出 (Code: ${code}) ❌`);
                }
            });

            proc.on('error', (err) => {
                if (this.process !== proc) return;
                this.reportStatus(`启动失败: ${err.message} ❌`);
                this.process = null;
                this.isStarting = false;
            });

            // 给予一定时间再检查状态
            setTimeout(() => this.plugin.checkConnection(), 3000);

        } catch (error) {
            this.reportStatus("启动流程遭遇意外错误 ❌");
            this.isStarting = false;
        }
    }

    /**
     * 强力清理并重新启动
     */
    public async forceKillAndStart() {
        this.reportStatus("正在清理 8000 端口并重新尝试手动启动...");
        await this.killPortConflict();
        // 给系统一点释放资源的时间
        await new Promise(r => setTimeout(r, 1000));
        await this.start({ force: true });
    }

    /**
     * 扫描并结束 8000 端口上的非本插件进程 (Windows 优先支持)
     */
    private async killPortConflict(): Promise<void> {
        return new Promise((resolve) => {
            const port = 8000;
            
            if (Platform.isWin) {
                // Windows 实现
                exec('netstat -ano | findstr :8000', (error, stdout) => {
                    if (error || !stdout) { resolve(); return; }
                    const lines = stdout.split('\n');
                    const pids = new Set<string>();
                    lines.forEach(line => {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && !isNaN(parseInt(pid)) && pid !== '0') pids.add(pid);
                    });
                    if (pids.size === 0) { resolve(); return; }

                    const targetPids: string[] = [];
                    const backendPathKey = this.plugin.settings.backendPath.split(/[\\/]/).pop() || "";
                    
                    try {
                        for (const pid of pids) {
                            const cmdInfo = execSync(`wmic process where processid=${pid} get commandline`).toString();
                            if (cmdInfo.includes("main:app") && (cmdInfo.includes(backendPathKey) || cmdInfo.includes("uv"))) {
                                targetPids.push(pid);
                            }
                        }
                    } catch (e) { /* ignore */ }

                    if (targetPids.length === 0) { resolve(); return; }
                    const pidStr = targetPids.join(' /PID ');
                    exec(`taskkill /F /PID ${pidStr}`, () => resolve());
                });
            } else {
                // Unix (macOS/Linux) 实现
                exec(`lsof -t -i :${port}`, (error, stdout) => {
                    if (error || !stdout) { resolve(); return; }
                    
                    const pids = stdout.trim().split('\n');
                    const targetPids: string[] = [];
                    const backendPathKey = this.plugin.settings.backendPath.split(/[\\/]/).pop() || "";

                    pids.forEach(pid => {
                        try {
                            const cmdLine = execSync(`ps -p ${pid} -o args=`).toString();
                            if (cmdLine.includes("main:app") && (cmdLine.includes(backendPathKey) || cmdLine.includes("uv"))) {
                                targetPids.push(pid);
                            }
                        } catch (e) { /* ignore */ }
                    });

                    if (targetPids.length === 0) { resolve(); return; }

                    exec(`kill -9 ${targetPids.join(' ')}`, () => {
                        this.reportStatus("已清理旧的后端进程");
                        resolve();
                    });
                });
            }
        });
    }

    /**
     * 停止后端服务
     */
    public stop() {
        if (!Platform.isDesktop) return;

        if (this.process && this.process.pid) {
            const targetPid = this.process.pid;
            this.reportStatus("正在停止服务并回收资源...");
            
            if (Platform.isWin) {
                // Windows 下必须使用 taskkill /T (Tree) 才能杀死通过 shell 启动的子进程
                // 使用 execSync 确保在插件 onunload 完成前同步结束进程
                try {
                    // 对 PID 使用引号包裹增加安全性
                    execSync(`taskkill /F /T /PID "${targetPid}"`);
                } catch (e) {
                    // 忽略进程可能已经自行退出的报错
                }
            } else {
                this.process.kill('SIGTERM');
            }
            
            this.process = null;
        }
    }

    /**
     * 运行 uv sync 确保环境最新
     */
    private async runSync(): Promise<void> {
        if (!Platform.isDesktop) return;

        return new Promise((resolve) => {
            const syncProc = spawn('uv', ['sync'], {
                cwd: this.plugin.settings.backendPath,
                shell: true
            });

            syncProc.stderr?.on('data', (data) => {
                const line = data.toString();
                if (line.includes("Resolved")) this.reportStatus("正在解析依赖关系...");
                if (line.includes("Prepared") || line.includes("Installed")) this.reportStatus("正在同步环境依赖...");
            });

            syncProc.on('close', () => {
                resolve();
            });
        });
    }

    public isRunning(): boolean {
        return this.process !== null;
    }

    /**
     * 判断是否正在处理启动流程（包括环境同步或进程拉起）
     */
    public isActivating(): boolean {
        return (this.isStarting || this.isRunning()) && Platform.isDesktop;
    }

    /**
     * 一键初始化虚拟环境并同步依赖 (uv venv + uv sync)
     */
    public async initializeEnvironment(): Promise<void> {
        const { backendPath } = this.plugin.settings;
        if (!backendPath) return;

        return new Promise(async (resolve, reject) => {
            try {
                // 1. 创建虚拟环境
                const venvProc = spawn('uv', ['venv'], {
                    cwd: backendPath,
                    shell: Platform.isWin
                });

                venvProc.on('close', async (code) => {
                    if (code !== 0) {
                        reject(new Error(t('ENV_FAILED')));
                        return;
                    }

                    // 2. 同步依赖
                    try {
                        await this.runSync();
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });

                venvProc.on('error', (err) => reject(new Error("Environment initialization failed (Process Error)")));
            } catch (error) {
                reject(new Error("Environment initialization failed (Unexpected Error)"));
            }
        });
    }
}
