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
    indexed_chunks?: number;
    failed_paths?: string[];
}

export interface DeleteIndexRequest {
    vault_id: string;
    paths: string[];
}

export interface DeleteIndexResponse {
    status: string;
    deleted?: number;
}

export interface IndexStatusResponse {
    total_notes: number;
    last_updated?: string;
    vault_id?: string;
    vault_stopwords?: string[];
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

// --- Radar Dual Stream Types ---

export interface RadarContext {
    path?: string;
    title?: string;
    heading?: string;
    text: string;
    tags?: string[];
    links?: string[];
    scope?: 'focus' | 'note';
}

export interface RadarSearchRequest {
    vault_id: string;
    context_id: string;
    context: RadarContext;
    top_k_related?: number;
    top_k_discover?: number;
    ranking_mode?: 'fast' | 'balanced' | 'high_quality';
    exclude_paths?: string[];
    mmr_lambda?: number;
}

export interface RadarCardItem {
    id: string;
    path: string;
    title: string;
    snippet: string;
    score: number;
    labels: string[];
    matched_chunk_index?: number;
}

export interface RadarSearchResponse {
    context_id: string;
    related: RadarCardItem[];
    discover: RadarCardItem[];
}

export interface HealthResponse {
    status: 'ok' | 'loading' | 'error';
    message: string;
    engine_version?: string;
    api_version?: string;
    embedding_model?: string;
    index_version?: string;
}

