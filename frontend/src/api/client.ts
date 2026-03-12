import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { SemantixSettings } from '../settings';
import { BatchIndexRequest, BatchIndexResponse, DeleteIndexRequest, DeleteIndexResponse, SemanticSearchRequest, SemanticSearchResponse, IndexStatusResponse } from './types';

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
        try {
            const url = `${this.baseUrl}/health`;
            const req: RequestUrlParam = {
                url,
                method: 'GET',
                contentType: 'application/json',
                headers: this.getAuthHeaders()
            };
            
            const res: RequestUrlResponse = await requestUrl(req);
            if (res.status === 200 && res.json && res.json.status === 'ok') {
                return true;
            }
            return false;
        } catch (error) {
            console.error("Semantix: Health check failed.", error);
            return false;
        }
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
                vault_id: this.vaultId
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
            console.error("Semantix: Index status failed.", error);
            return null;
        }
    }

    public getVaultId(): string {
        return this.vaultId;
    }
}
