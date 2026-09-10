# Semantix 开发指南

## 工作目录

- `frontend/`: Obsidian 插件 (TypeScript + esbuild)
- `backend/`: FastAPI 后端 (Python 3.11+)

## 常用命令

### 前端
```bash
cd frontend
npm run dev      # 开发模式 (watch)
npm run build   # 生产构建
npm run lint    # ESLint 检查
```

### 后端
```bash
cd backend
uv sync                    # 安装依赖
uv run uvicorn main:app --host 127.0.0.1 --port 8000   # 启动服务
uv run pytest            # 运行测试
```

### 版本发布
```bash
cd frontend
npm run version [patch|minor|major]   # 自动同步版本至 manifest.json, versions.json, README.md
git add -A && git commit -m "Bump version"
git tag v<x.y.z> && git push --tags
```

## 构建顺序

1. `npm run build` (frontend)
2. 复制 `main.js`, `manifest.json`, `styles.css` 到 Obsidian 插件目录

## 技术细节

- 模型首次启动自动下载至本地缓存 (BAAI/bge-small-zh-v1.5 + BAAI/bge-reranker-base)
- 数据库: LanceDB，默认存储路径 `./semantix_lance`
- 架构分层:
  - `backend/storage/`: LanceDBStorage 物理存储与隔离
  - `backend/services/`: EmbeddingService, RerankerService, RetrievalService, IndexService
  - `backend/services/ranking/`: 归一化、Related 精排、Discover MMR 打散与标签生成
  - `backend/services/radar_service.py`: 统一双流编排管线
- 搜索前缀: `为这个句子生成表示以用于检索相关文章：` (由 EmbeddingService 自动注入)
- 全局版本号驱动的 SSOT: `frontend/package.json` 的 `version`

## 环境变量 (可选)

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| SEMANTIX_API_TOKEN | - | 鉴权 Token |
| SEMANTIX_DB_PATH | `./semantix_lance` | 索引存储路径 |
| SEMANTIX_LOG_LEVEL | `INFO` | 日志级别 |

## CI/CD

- `lint.yml`: 全量 CI 检查（前端 lint/build + 后端 pytest）
- `release.yml`: 生产 Release（直接发布 main.js、manifest.json、styles.css，配置 attest-build-provenance，禁用 .zip）

## 注意事项

- 版本号必须通过 `npm run version` 更改，禁止直接编辑 package.json
- 后端模块解耦后，禁止直接在业务逻辑中重新实例化 SentenceTransformer / CrossEncoder，必须通过统一单例服务调用