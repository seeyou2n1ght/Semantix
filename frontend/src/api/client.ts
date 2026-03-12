import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { SemantixSettings } from '../settings';
import { BatchIndexRequest, BatchIndexResponse, DeleteIndexRequest, DeleteIndexResponse, SemanticSearchRequest, SemanticSearchResponse } from './types';

export class ApiClient {
    private settings: SemantixSettings;

    constructor(settings: SemantixSettings) {
        this.settings = settings;
    }

    public updateSettings(settings: SemantixSettings) {
        this.settings = settings;
    }

    private get baseUrl(): string {
        // Ensure no trailing slash
        return this.settings.backendUrl.replace(/\/$/, '');
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
                contentType: 'application/json'
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
            const res = await requestUrl({
                url: `${this.baseUrl}/index/batch`,
                method: 'POST',
                contentType: 'application/json',
                body: JSON.stringify(request) // requestUrl requires body string
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
            const res = await requestUrl({
                url: `${this.baseUrl}/index/delete`,
                method: 'POST',
                contentType: 'application/json',
                body: JSON.stringify(request)
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
            const res = await requestUrl({
                url: `${this.baseUrl}/search/semantic`,
                method: 'POST',
                contentType: 'application/json',
                body: JSON.stringify(request)
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
}
