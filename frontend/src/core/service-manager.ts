import { Notice, Platform } from 'obsidian';
import SemantixPlugin from '../main';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export class ServiceManager {
    private plugin: SemantixPlugin;
    private process: ChildProcess | null = null;
    private isStarting: boolean = false;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
    }

    /**
     * 根据配置启动后端服务
     */
    public async start() {
        if (!Platform.isDesktop) return;
        if (this.process || this.isStarting) return;

        const { settings } = this.plugin;
        if (settings.backendMode !== 'local' || !settings.autoStartServer) return;

        if (!settings.backendPath || settings.backendPath.trim() === '') {
            console.warn("Semantix: Backend path is not set. Sidecar startup skipped.");
            return;
        }

        this.isStarting = true;
        this.plugin.updateAllViewStatus('syncing');
        console.log("Semantix Sidecar: Initializing startup...");

        try {
            // 1. (可选) 执行 uv sync
            if (settings.uvSyncOnStart && settings.pythonPath === 'uv') {
                await this.runSync();
            }

            // 2. 构造启动命令
            // 默认驱动命令: uv run uvicorn main:app --port 8000
            // 如果 pythonPath 不是 uv，则尝试: python -m uvicorn main:app --port 8000
            const args = settings.pythonPath === 'uv' 
                ? ['run', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000']
                : ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'];

            console.log(`Semantix Sidecar: Spawning process ${settings.pythonPath} in ${settings.backendPath}`);

            this.process = spawn(settings.pythonPath, args, {
                cwd: settings.backendPath,
                shell: Platform.isWin, // Windows 必须开启 shell 才能正确拉起 uv/python
                detached: false
            });

            this.process.stdout?.on('data', (data) => {
                console.log(`[Semantix Backend]: ${data}`);
            });

            this.process.stderr?.on('data', (data) => {
                const msg = data.toString();
                // 过滤掉一些普通的 uvicorn 输出，只记录真正的错误
                if (msg.includes('ERROR') || msg.includes('Traceback')) {
                    console.error(`[Semantix Backend Error]: ${msg}`);
                } else {
                    console.debug(`[Semantix Backend Log]: ${msg}`);
                }
            });

            this.process.on('close', (code) => {
                console.log(`Semantix Sidecar: Process exited with code ${code}`);
                this.process = null;
                this.isStarting = false;
                this.plugin.checkConnection();
            });

            this.process.on('error', (err) => {
                console.error("Semantix Sidecar: Failed to start process.", err);
                new Notice(`Semantix: 边车启动失败 - ${err.message}`);
                this.process = null;
                this.isStarting = false;
            });

            // 给予一点点回弹时间再检查
            setTimeout(() => this.plugin.checkConnection(), 2000);

        } catch (error) {
            console.error("Semantix Sidecar: Unexpected error during startup.", error);
            this.isStarting = false;
        }
    }

    /**
     * 停止后端服务
     */
    public stop() {
        if (this.process) {
            console.log("Semantix Sidecar: Stopping process...");
            // 在 Windows 上，简单的 kill 可能杀不掉 shell 派生的子树，
            // 但对于 uvicorn 这种简单进程，通常有效。
            this.process.kill();
            this.process = null;
        }
    }

    /**
     * 运行 uv sync 确保环境最新
     */
    private async runSync(): Promise<void> {
        return new Promise((resolve) => {
            console.log("Semantix Sidecar: Syncing dependencies (uv sync)...");
            const syncProc = spawn('uv', ['sync'], {
                cwd: this.plugin.settings.backendPath,
                shell: Platform.isWin
            });

            syncProc.on('close', (code) => {
                if (code === 0) {
                    console.log("Semantix Sidecar: Dependencies synced.");
                } else {
                    console.warn(`Semantix Sidecar: uv sync exited with code ${code}`);
                }
                resolve();
            });
        });
    }

    public isRunning(): boolean {
        return this.process !== null;
    }
}
