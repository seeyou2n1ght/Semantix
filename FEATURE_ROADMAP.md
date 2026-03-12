# Semantix 功能规划路线图

本文档记录计划中的功能改进，包括痛点分析、解决方案和实施细节。

---

## 1. 冷启动优化 (Cold Start Optimization)

### 1.1 痛点分析

当用户首次安装插件并配置后端时，Vault 可能有数千篇历史笔记。全量索引需要几分钟甚至更长时间，期间若无反馈，用户会认为插件损坏。

### 1.2 解决方案

| 功能点 | 描述 | 复杂度 |
|--------|------|--------|
| 初始化按钮 | 设置页新增 `[初始化向量雷达]` 按钮，带确认弹窗 | 低 |
| 进度反馈 | 侧边栏显示 `Indexing: 450 / 3000 files`，带进度条 | 中 |
| 后台执行 | 前端分批调用（每批 50 条），用 `setTimeout` 让出主线程 | 中 |
| 取消操作 | 支持用户中途取消索引 | 低 |

**决策补充：**
- 冷启动进度不做持久化；页面关闭或重启将重置进度，需在 UI 明确提示。

### 1.3 交互流程

```
用户点击 [初始化向量雷达]
    ↓
弹窗确认："将索引约 3000 篇笔记，预计耗时 5-10 分钟"
    ↓
用户确认
    ↓
侧边栏显示进度条：
┌─────────────────────────────────┐
│ 🔄 初始化向量索引                │
│ ████████░░░░░░░░░░  450 / 3000  │
│ 预计剩余时间: 8 分钟             │
│ [取消]                           │
└─────────────────────────────────┘
    ↓
完成后显示：✅ 索引完成！
```

### 1.4 技术实现要点

**前端分批索引：**
```typescript
async function batchIndex(files: TFile[], batchSize = 50) {
    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await this.indexBatch(batch);
        this.updateProgress(i + batch.length, files.length);
        await new Promise(r => setTimeout(r, 0)); // 让出主线程
    }
}
```

**后端接口：**
- `POST /index/full` - 启动全量索引，返回任务 ID
- `GET /index/progress` - 获取索引进度

### 1.5 变更文件

| 文件 | 变更 |
|------|------|
| `frontend/src/settings.ts` | 新增初始化按钮 + 确认弹窗 |
| `frontend/src/main.ts` | 新增 `initIndex()` 方法 |
| `frontend/src/ui/whisperer-view.ts` | 新增进度显示方法 |
| `frontend/src/ui/radar-view.ts` | 同步显示进度 |
| `backend/main.py` | 新增进度查询接口 |
| `backend/db_svc.py` | 新增进度追踪 |

---

## 2. 隐私边界增强 (Privacy & Scope Isolation)

### 2.1 痛点分析

用户 Obsidian 既包含技术文档，也包含私人日记。不希望在技术写作时召回私人内容。

### 2.2 解决方案

| 功能点 | 描述 | 复杂度 |
|--------|------|--------|
| 文件夹选择器 | 可视化多选文件夹，排除特定目录 | 中 |
| 正则支持 | 新增正则表达式排除规则 | 低 |
| 实时预览 | 设置时显示匹配的文件数量 | 中 |

**决策补充：**
- 排除规则与 UI 行为参考 Obsidian 核心插件相关组件（交互、选择器样式、规则语义）。

### 2.3 UI 设计

```
┌─────────────────────────────────────────────┐
│ Ignored Folders                             │
│ ┌─────────────────────────────────────────┐ │
│ │ ☑ Journal/                              │ │
│ │ ☑ Personal/                             │ │
│ │ ☐ Templates/                            │ │
│ │ ☐ Attachments/                          │ │
│ │ ☑ Archive/                              │ │
│ └─────────────────────────────────────────┘ │
│ 已排除 42 个文件                            │
│ [刷新文件夹列表]                            │
└─────────────────────────────────────────────┘
```

### 2.4 技术实现要点

**Obsidian API 获取文件夹：**
```typescript
async getFolders(): Promise<string[]> {
    const folders: string[] = [];
    const files = this.app.vault.getAllLoadedFiles();
    for (const file of files) {
        if (file instanceof TFolder) {
            folders.push(file.path);
        }
    }
    return folders;
}
```

**改进后的排除逻辑：**
```typescript
private isExcluded(path: string): boolean {
    // 1. 文件夹列表匹配
    const excludedFolders = this.plugin.settings.excludedFolders || [];
    for (const folder of excludedFolders) {
        if (path.startsWith(folder + '/')) return true;
    }
    
    // 2. 前缀匹配（兼容现有配置）
    const prefixRules = this.plugin.settings.exclusionRules.split('\n')...;
    for (const rule of prefixRules) {
        if (path.startsWith(rule)) return true;
    }
    
    // 3. 正则匹配（可选）
    const regexRules = this.plugin.settings.exclusionRegex?.split('\n')... || [];
    for (const pattern of regexRules) {
        try {
            if (new RegExp(pattern).test(path)) return true;
        } catch (e) { /* 忽略无效正则 */ }
    }
    
    return false;
}
```

### 2.5 变更文件

| 文件 | 变更 |
|------|------|
| `frontend/src/settings.ts` | 新增文件夹选择器 UI |
| `frontend/src/settings.ts` | 新增 `excludedFolders: string[]` 配置 |
| `frontend/src/core/sync.ts` | 改进 `isExcluded()` 方法 |

---

## 3. UI 闪烁优化 (Skeleton UI & Smooth Transitions)

### 3.1 痛点分析

C/S 架构存在网络延迟，每次搜索时侧边栏立刻清空再填充，造成视觉闪烁。

### 3.2 解决方案

| 功能点 | 描述 | 复杂度 |
|--------|------|--------|
| 骨架屏 | 请求期间显示灰色占位卡片，带呼吸灯效果 | 中 |
| 保留旧数据 | 请求期间不清空，降低透明度 | 低 |
| 平滑替换 | 新数据到达后动画过渡 | 中 |

### 3.3 UI 效果

**骨架屏样式：**
```css
.skeleton-card {
    background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 8px;
}

.skeleton-title {
    height: 16px;
    width: 60%;
    background: #ddd;
    border-radius: 4px;
    margin-bottom: 8px;
}

.skeleton-text {
    height: 12px;
    width: 100%;
    background: #ddd;
    border-radius: 4px;
}

@keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
}
```

### 3.4 技术实现要点

**改进渲染流程：**
```typescript
public showLoading() {
    if (!this.whispererContainer) return;
    
    // 保留旧数据，降低透明度
    this.whispererContainer.style.opacity = "0.5";
    
    // 添加加载指示器
    const loadingEl = this.containerEl.createEl("div", { cls: "semantix-loading" });
    loadingEl.innerHTML = `
        <div class="skeleton-card">
            <div class="skeleton-title"></div>
            <div class="skeleton-text"></div>
        </div>
    `;
}

public renderWhispererResults(results, colorSettings) {
    // 移除加载状态
    this.containerEl.querySelector(".semantix-loading")?.remove();
    this.whispererContainer.style.opacity = "1";
    
    // 渲染结果
    // ...
}
```

### 3.5 变更文件

| 文件 | 变更 |
|------|------|
| `frontend/src/ui/whisperer-view.ts` | 新增骨架屏方法 |
| `frontend/src/ui/radar-view.ts` | 同步骨架屏效果 |
| `frontend/src/core/whisperer.ts` | 搜索前调用 `showLoading()` |

---

## 4. 召回结果可解释性 (Explainable Results)

### 4.1 痛点分析

用户不知道为什么某篇笔记被召回，无法建立信任。

### 4.2 解决方案

采用**混合方案**：全文索引 + 段落定位（可选开关）

| 功能点 | 描述 | 复杂度 |
|--------|------|--------|
| 段落切分 | 后端将笔记按段落切分 | 中 |
| 相似段落定位 | 返回最匹配的段落而非全文开头 | 中 |
| 关键词高亮 | 高亮匹配的关键词 | 低 |

**决策补充：**
- 解释性作为可选开关，默认关闭以规避性能回退；开启后对搜索流程加额外处理。
- snippet 默认只展示 Top-1 最匹配段落（后续可扩展 Top-2/3 展开）。

### 4.3 性能开销分析

| 指标 | 当前方案 | 混合方案 | 增量 |
|------|----------|----------|------|
| 单次查询延迟 | 25-30ms | 40-50ms | +15-20ms |
| 后端 CPU 峰值 | 低 | 中等 | +50% |
| 首次查询（无缓存） | 25-30ms | 40-50ms | +15-20ms |
| 重复查询（有缓存） | 25-30ms | 25-30ms | 无 |

**结论：** 性能开销可接受（+15-20ms），缓存后无额外开销。

### 4.4 技术实现要点

**段落切分工具：**
```python
# backend/utils/chunker.py
def split_into_chunks(text: str, max_length: int = 500, overlap: int = 50) -> List[str]:
    """将文本按段落切分，支持重叠"""
    paragraphs = text.split('\n\n')
    chunks = []
    current_chunk = ""
    
    for para in paragraphs:
        if len(current_chunk) + len(para) <= max_length:
            current_chunk += para + "\n\n"
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = para + "\n\n"
    
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    return chunks
```

**搜索时定位最相似段落：**
```python
def search_with_context(self, query_vector, ...):
    results = self.table.search(query_vector)...
    
    for row in results:
        # 切分段落
        chunks = split_into_chunks(row["text"])
        
        # 计算 chunk embeddings
        chunk_vectors = model_svc.encode(chunks)
        
        # 找最相似的 chunk
        similarities = cosine_similarity(query_vector, chunk_vectors)
        best_idx = np.argmax(similarities)
        
        results.append({
            "path": row["path"],
            "score": similarity,
            "snippet": chunks[best_idx],  # 最匹配的段落
            "matched_chunk_index": best_idx,
        })
    
    return results
```

**缓存策略：**
```python
# 缓存笔记的 chunk embeddings，避免重复计算
chunk_cache: Dict[str, Tuple[List[str], List[List[float]]]] = {}

def get_chunks_with_embeddings(path: str, text: str):
    if path in chunk_cache:
        return chunk_cache[path]
    
    chunks = split_into_chunks(text)
    embeddings = model_svc.encode(chunks)
    chunk_cache[path] = (chunks, embeddings)
    return chunks, embeddings
```

### 4.5 UI 效果

```
┌─────────────────────────────────────────────┐
│ 📄 Linux 内核模块管理              🟢 92%   │
│                                              │
│ "...网关配置需要修改 iptables 规则，        │
│  可以使用 modprobe 加载相应的内核模块..."   │
│                     ↑ 匹配段落              │
└─────────────────────────────────────────────┘
```

### 4.6 变更文件

| 文件 | 变更 |
|------|------|
| `backend/utils/chunker.py` | 新建段落切分工具 |
| `backend/models.py` | `SearchResultItem` 新增 `matched_chunk` 字段 |
| `backend/db_svc.py` | 新增 `search_with_context()` 方法 |
| `backend/main.py` | 新增 `with_context` 参数 |
| `frontend/src/api/types.ts` | 更新类型定义 |
| `frontend/src/ui/whisperer-view.ts` | 渲染匹配段落 |

---

## 5. 优先级与时间估算

| 阶段 | 功能 | 优先级 | 预计工作量 |
|------|------|--------|------------|
| 第一阶段 | 冷启动优化 | P0 | 2-3 小时 |
| 第二阶段 | 隐私边界增强 | P1 | 1-2 小时 |
| 第三阶段 | UI 闪烁优化 | P1 | 1 小时 |
| 第四阶段 | 可解释性增强 | P2 | 2-3 小时 |
| **总计** | | | **6-9 小时** |

---

## 6. 待决策事项

### 6.1 冷启动
- [ ] 进度条放在侧边栏顶部还是设置页面？
- [ ] 是否需要显示预计剩余时间？
- [ ] 是否支持取消操作？
- [x] 进度是否持久化？不需要持久化（重启重置，UI 明示）。

### 6.2 隐私边界
- [ ] 文件夹选择器是否需要搜索过滤？
- [ ] 是否需要支持正则表达式？
- [ ] 是否需要实时预览排除文件数量？
- [x] 排除规则参考 Obsidian 核心插件组件与交互语义。

### 6.3 可解释性
- [ ] 段落切分长度：500 字符是否合适？
- [ ] 是否需要缓存？缓存过期策略？
- [ ] 是否需要高亮关键词？如何实现？
- [x] 解释性作为可选开关（默认关闭）。
- [x] snippet 默认只展示 Top-1 最匹配段落。

---

## 7. 版本规划

| 版本 | 功能 |
|------|------|
| v0.3.0 | 冷启动优化、隐私边界增强 |
| v0.4.0 | UI 闪烁优化、可解释性增强 |
| v0.5.0 | 缓存优化、性能调优 |
