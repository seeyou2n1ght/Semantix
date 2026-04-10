import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { SemantixSettings } from '../settings';
import { BatchIndexRequest, BatchIndexResponse, DeleteIndexRequest, DeleteIndexResponse, SemanticSearchRequest, SemanticSearchResponse, IndexStatusResponse } from './types';

export enum HealthStatus {
    READY = "READY",       // 我们的后端已就绪
    CONFLICT = "CONFLICT", // 端口被占用（非本插件后端）
    NONE = "NONE"          // 端口空闲
}

export class ApiClient {
    private settings: SemantixSettings;
    private vaultId: string;

    constructor(settings: SemantixSettings, vaultId: string) {
        this.settings = settings;
        this.vaultId = vaultId;
    }

    public updateSettings(settings: SemantixSettings, vaultId?: string) {
        this.settings = settings;
        if (vaultId) this.vaultId = vaultId;
    }

    private get baseUrl(): string {
        // Ensure no trailing slash
        return this.settings.backendUrl.replace(/\/$/, '');
    }

    private getAuthHeaders(): Record<string, string> {
        if (this.settings.apiToken && this.settings.apiToken.trim() !== '') {
            return { "X-Semantix-Token": this.settings.apiToken.trim() };
        }
        return {};
    }

    /**
     * Test connection to the backend (/health)
     * @returns true if connected, false otherwise
     */
    async checkHealth(): Promise<boolean> {
        const status = await this.checkFullHealth();
        return status === HealthStatus.READY;
    }

    /**
     * 深度探活：识别端口是被正确占用、被错误占用、还是空闲
     * 引入 5 秒硬超时机制，防止 Obsidian requestUrl 挂起导致 UI 无响应
     */
    async checkFullHealth(): Promise<HealthStatus> {
        const fetchStatus = async (): Promise<HealthStatus> => {
            try {
                const url = `${this.baseUrl}/health`;
                const req: RequestUrlParam = {
                    url,
                    method: 'GET',
                    contentType: 'application/json',
                    headers: this.getAuthHeaders(),
                    throw: false
                };
                
                const res: RequestUrlResponse = await requestUrl(req);
                
                if (res.status === 200 && res.json && res.json.status === 'ok') {
                    return HealthStatus.READY;
                }
                return HealthStatus.CONFLICT;
            } catch (error) {
                return HealthStatus.NONE;
            }
        };

        const timeout = new Promise<HealthStatus>((resolve) => {
            setTimeout(() => resolve(HealthStatus.NONE), 5000);
        });

        return Promise.race([fetchStatus(), timeout]);
    }

    /**
     * Batch index documents
     */
    async indexBatch(request: BatchIndexRequest): Promise<BatchIndexResponse | null> {
        if (request.documents.length === 0) return { status: 'success', indexed: 0 };
        try {
            const payload: BatchIndexRequest = {
                documents: request.documents.map(doc => ({
                    ...doc,
                    vault_id: doc.vault_id || this.vaultId
                }))
            };
            const res = await requestUrl({
                url: `${this.baseUrl}/index/batch`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload) // requestUrl requires body string
            });
            if (res.status === 200 && res.json) {
                return res.json;
            }
            return null;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Semantix: Batch index failed.", error);
            return null;
        }
    }

    /**
     * Delete files from index
     */
    async indexDelete(request: DeleteIndexRequest): Promise<DeleteIndexResponse | null> {
        if (request.paths.length === 0) return { status: 'success', deleted: 0 };
        try {
            const payload: DeleteIndexRequest = {
                ...request,
                vault_id: this.vaultId
            };
            const res = await requestUrl({
                url: `${this.baseUrl}/index/delete`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload)
            });
            if (res.status === 200 && res.json) {
                return res.json;
            }
            return null;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Semantix: Delete index failed.", error);
            return null;
        }
    }

    /**
     * Search for similar documents
     */
    async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResponse | null> {
        if (!request.text || request.text.trim() === '') return { results: [] };
        try {
            const payload: SemanticSearchRequest = {
                ...request,
                vault_id: this.vaultId,
                min_similarity: request.min_similarity
            };
            const res = await requestUrl({
                url: `${this.baseUrl}/search/semantic`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload)
            });
            if (res.status === 200 && res.json) {
                return res.json;
            }
            return null;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return null;
            // eslint-disable-next-line no-console
            console.error("Semantix: Semantic search failed.", error);
            return null;
        }
    }

    async getIndexStatus(): Promise<IndexStatusResponse | null> {
        try {
            const url = `${this.baseUrl}/index/status?vault_id=${encodeURIComponent(this.vaultId)}`;
            const res = await requestUrl({
                url,
                method: 'GET',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            if (res.status === 200 && res.json) {
                return res.json;
            }
            return null;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Semantix: Index status failed.", error);
            return null;
        }
    }

    /**
     * 清空向量数据库索引（两步确认）
     * 第一步：请求清空，获取确认 token
     * 第二步：使用 token 确认清空
     */
    async clearIndex(): Promise<boolean> {
        try {
            const requestRes = await requestUrl({
                url: `${this.baseUrl}/index/clear/request`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            
            if (requestRes.status !== 200 || !requestRes.json) {
                return false;
            }
            
            const token = requestRes.json.confirmation_token;
            if (!token) {
                return false;
            }
            
            const confirmRes = await requestUrl({
                url: `${this.baseUrl}/index/clear/confirm`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ confirmation_token: token })
            });
            
            return confirmRes.status === 200;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Semantix: Clear index failed.", error);
            return false;
        }
    }

    public getVaultId(): string {
        return this.vaultId;
    }

    /**
     * 发送心跳信号，告诉后端我们还在运行
     */
    async ping(): Promise<void> {
        try {
            await requestUrl({
                url: `${this.baseUrl}/ping`,
                method: 'GET',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                throw: false
            });
        } catch (e) {
            // 静默失败，心跳丢失一两次是正常的由后端缓冲区处理
        }
    }

    /**
     * 获取系统运行指标
     */
    async getMetrics(): Promise<any | null> {
        try {
            const res = await requestUrl({
                url: `${this.baseUrl}/metrics`,
                method: 'GET',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            if (res.status === 200 && res.json) {
                return res.json;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 手动触发磁盘维护
     */
    async runMaintenance(retentionDays: number): Promise<boolean> {
        try {
            const res = await requestUrl({
                url: `${this.baseUrl}/maintenance/run`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ retention_days: retentionDays })
            });
            return res.status === 200;
        } catch (e) {
            return false;
        }
    }
}
