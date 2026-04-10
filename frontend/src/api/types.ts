export interface IndexDocument {
    vault_id: string;
    path: string;
    text: string;
    tags?: string[];
    links?: string[];
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
    min_similarity?: number;
    with_context?: boolean;
    rerank?: boolean;
    current_path?: string;
    current_tags?: string[];
    current_links?: string[];
}

export interface SearchResultItem {
    path: string;
    score: number;
    snippet: string;
    matched_chunk_index?: number;
    reasons?: string[];
    score_details?: { [key: string]: number };
}

export interface SemanticSearchResponse {
    results: SearchResultItem[];
}

export interface IndexStatusResponse {
    total_notes: number;
    last_updated?: string;
    vault_id?: string;
}

export interface ClearIndexRequestResponse {
    status: string;
    message: string;
    confirmation_token: string;
    scope: string;
}

export interface ClearIndexConfirmResponse {
    status: string;
    message: string;
    cleared_at: string;
}
