export interface IndexDocument {
    vault_id: string;
    path: string;
    text: string;
}

export interface BatchIndexRequest {
    documents: IndexDocument[];
}

export interface BatchIndexResponse {
    status: string;
    indexed: number;
}

export interface DeleteIndexRequest {
    vault_id: string;
    paths: string[];
}

export interface DeleteIndexResponse {
    status: string;
    deleted?: number;
}

export interface SemanticSearchRequest {
    vault_id: string;
    text: string;
    top_k: number;
    exclude_paths?: string[];
}

export interface SearchResultItem {
    path: string;
    score: number;
    snippet: string;
}

export interface SemanticSearchResponse {
    results: SearchResultItem[];
}

export interface IndexStatusResponse {
    total_notes: number;
    last_updated?: string;
    vault_id?: string;
}
