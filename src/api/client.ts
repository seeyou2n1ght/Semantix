import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { SemantixSettings } from '../settings';
import {
    BatchIndexRequest,
    BatchIndexResponse,
    DeleteIndexRequest,
    DeleteIndexResponse,
    IndexStatusResponse,
    RadarSearchRequest,
    RadarSearchResponse,
    HealthResponse,
    ClearIndexRequestResponse,
} from './types';

export enum HealthStatus {
    READY = "READY",       // µêæõ╗¼þÜäÕÉÄþ½»ÕÀ▓Õ░▒þ╗¬
    LOADING = "LOADING",   // µêæõ╗¼þÜäÕÉÄþ½»µ¡úÕ£¿ÕèáÞ¢¢µ¿íÕ×ï
    CONFLICT = "CONFLICT", // þ½»ÕÅúÞó½Õìáþö¿´╝êÚØ×µ£¼µÅÆõ╗ÂÕÉÄþ½»µêûµ£¬þƒÑÕôìÕ║ö´╝ë
    NONE = "NONE"          // þ½»ÕÅúþ®║Úù▓
}

export class ApiClient {
    private settings: SemantixSettings;
    private vaultId: string;
    public lastHealthResponse: HealthResponse | null = null;

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
     * µÀ▒Õ║ªµÄóµ┤╗´╝ÜÞ»åÕê½þ½»ÕÅúµÿ»Þó½µ¡úþí«Õìáþö¿ÒÇüÞó½ÚöÖÞ»»Õìáþö¿ÒÇüÞ┐ÿµÿ»þ®║Úù▓
     * Õ╝òÕàÑ 5 þºÆþí¼ÞÂàµùÂµ£║ÕêÂ´╝îÚÿ▓µ¡ó Obsidian requestUrl µîéÞÁÀÕ»╝Þç┤ UI µùáÕôìÕ║ö
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
                
                if (res.status === 200 && res.json) {
                    const healthData = res.json as HealthResponse;
                    if (healthData.status === 'ok') {
                        this.lastHealthResponse = healthData;
                        return HealthStatus.READY;
                    }
                    if (healthData.status === 'loading') {
                        this.lastHealthResponse = healthData;
                        return HealthStatus.LOADING;
                    }
                }
                this.lastHealthResponse = null;
                return HealthStatus.CONFLICT;
            } catch {
                this.lastHealthResponse = null;
                return HealthStatus.NONE;
            }
        };

        const timeout = new Promise<HealthStatus>((resolve) => {
            window.setTimeout(() => resolve(HealthStatus.NONE), 5000);
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
                return res.json as BatchIndexResponse;
            }
            return null;
        } catch (error) {
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
                return res.json as DeleteIndexResponse;
            }
            return null;
        } catch (error) {
            console.error("Semantix: Delete index failed.", error);
            return null;
        }
    }

    /**
     * Dual Stream Radar Search (/search/radar)
     */
    async radarSearch(request: RadarSearchRequest): Promise<RadarSearchResponse | null> {
        if (!request.context.text || request.context.text.trim() === '') {
            return { context_id: request.context_id, related: [], discover: [] };
        }
        try {
            const payload: RadarSearchRequest = {
                ...request,
                vault_id: this.vaultId,
            };
            const res = await requestUrl({
                url: `${this.baseUrl}/search/radar`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload)
            });
            if (res.status === 200 && res.json) {
                return res.json as RadarSearchResponse;
            }
            return null;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return null;
            console.error("Semantix: Radar search failed.", error);
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
                return res.json as IndexStatusResponse;
            }
            return null;
        } catch (error) {
            console.error("Semantix: Index status failed.", error);
            return null;
        }
    }

    /**
     * 清空向量数据库索引（两步确认）
     * 第一步：请求清空，获取确认 token
     * 第二步：使用 token 确认清空
     */
    async clearIndex(vaultId?: string): Promise<boolean> {
        const targetVault = vaultId || this.vaultId;
        if (!targetVault) {
            console.error("Semantix: Clear index aborted because vaultId is empty.");
            return false;
        }
        try {
            const url = `${this.baseUrl}/index/clear/request?vault_id=${encodeURIComponent(targetVault)}`;
            const requestRes = await requestUrl({
                url,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            
            if (requestRes.status !== 200 || !requestRes.json) {
                return false;
            }
            
            const clearData = requestRes.json as ClearIndexRequestResponse;
            const token = clearData.confirmation_token;
            if (!token) {
                return false;
            }
            
            const confirmPayload: { confirmation_token: string; vault_id: string } = {
                confirmation_token: token,
                vault_id: targetVault
            };

            const confirmRes = await requestUrl({
                url: `${this.baseUrl}/index/clear/confirm`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(confirmPayload)
            });
            
            return confirmRes.status === 200;
        } catch (error) {
            console.error("Semantix: Clear index failed.", error);
            return false;
        }
    }

    public getVaultId(): string {
        return this.vaultId;
    }

    /**
     * ÕÅæÚÇüÕ┐âÞÀ│õ┐íÕÅÀ´╝îÕæèÞ»ëÕÉÄþ½»µêæõ╗¼Þ┐ÿÕ£¿Þ┐ÉÞíî
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
        } catch {
            // ÚØÖÚ╗ÿÕñ▒Þ┤Ñ´╝îÕ┐âÞÀ│õ©óÕñ▒õ©Çõ©ñµ¼íþö▒ÕÉÄþ½»þ╝ôÕå▓Õî║ÕñäþÉå
        }
    }

    /**
     * ÞÄÀÕÅûþ│╗þ╗ƒÞ┐ÉÞíîµîçµáç
     */
    async getMetrics(): Promise<Record<string, unknown> | null> {
        try {
            const res = await requestUrl({
                url: `${this.baseUrl}/metrics?vault_id=${encodeURIComponent(this.vaultId)}`,
                method: 'GET',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            if (res.status === 200 && res.json) {
                return res.json as Record<string, unknown>;
            }
            return null;
        } catch {
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
        } catch {
            return false;
        }
    }

    /**
     * 触发启发式噪音词计算 (方案二)
     */
    async computeStopwords(): Promise<{status: string, count: number, words: string[]} | null> {
        try {
            const res = await requestUrl({
                url: `${this.baseUrl}/index/compute-stopwords`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ vault_id: this.vaultId })
            });
            if (res.status === 200 && res.json) {
                return res.json as {status: string, count: number, words: string[]};
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * µÿ¥Õ╝ÅÞºªÕÅæ FTS ÕÇÆµÄÆþ┤óÕ╝òÕì│µùÂµ×äÕ╗║
     */
    async rebuildFtsIndex(): Promise<boolean> {
        try {
            const res = await requestUrl({
                url: `${this.baseUrl}/index/rebuild-fts`,
                method: 'POST',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            });
            return res.status === 200;
        } catch {
            return false;
        }
    }
}
