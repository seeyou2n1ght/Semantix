export interface IndexDocument {
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
    paths: string[];
}

export interface DeleteIndexResponse {
    status: string;
    deleted?: number;
}

export interface SemanticSearchRequest {
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
