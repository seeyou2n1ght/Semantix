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

- 模型首次启动自动下载 (BAAI/bge-small-zh-v1.5 + BAAI/bge-reranker-base)
- 数据库: LanceDB，默认路径 `./semantix.db`
- 搜索前缀: `为这个句子生成表示以用于检索相关文章：`
- 全局版本号驱动的 SSOT: `frontend/package.json` 的 `version`

## 环境变量 (可选)

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| SEMANTIX_API_TOKEN | - | 鉴权 Token |
| SEMANTIX_DB_PATH | `./semantix.db` | 索引存储路径 |
| SEMANTIX_LOG_LEVEL | `INFO` | 日志级别 |

## CI/CD

- `lint.yml`: 前端 lint (push/PR 触发)
- `release.yml`: 构建并发布 Release (tag 触发)

## 注意事项

- 后端搜索接口需带前缀 `"为这个句子生成表示以用于检索相关文章："` 才能正确调用 bge-small-zh-v1.5
- 版本号必须通过 `npm run version` 更改，禁止直接编辑 package.json