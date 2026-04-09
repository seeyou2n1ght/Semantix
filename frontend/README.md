# Semantix Frontend

`frontend/` 是 Semantix 的 Obsidian 插件部分。

它负责：

- 注册插件设置与两个侧边栏视图
- 监听编辑器与 Vault 文件事件
- 清洗 Markdown 文本
- 调用后端完成索引与语义搜索

## 目录结构

```text
src/
  api/
    client.ts          后端 API 客户端
    types.ts           前后端请求与响应类型
  core/
    whisperer.ts       实时搜索触发逻辑
    radar.ts           孤岛笔记扫描与推荐
    sync.ts            增量同步队列
  ui/
    whisperer-view.ts  Whisperer 侧边栏
    radar-view.ts      Radar 侧边栏
  utils/
    markdown.ts        Markdown 清洗
  main.ts              插件入口
  settings.ts          设置页定义
```

## 关键行为

### Whisperer

- 文件打开时立即尝试搜索
- 编辑内容时使用防抖触发搜索
- 在段落模式下，光标移动后也会触发搜索
- 可排除当前文件和已链接文件

### SyncManager

- 监听 `create / modify / rename / delete`
- 合并为待更新队列和待删除队列
- 到达批次时间后统一 flush
- 重命名按“删旧路径 + 写新路径”处理

### Orphan Radar

- 基于 `app.metadataCache.resolvedLinks` 统计出链和入链
- 选出总链接数为 `0` 的 Markdown 文件
- 用户展开某项时再发起语义推荐请求

## 构建

要求：

- Node.js `>= 18`

安装与构建：

```bash
npm install
npm run dev
npm run build
npm run lint
```

## 安装到 Vault

构建完成后，把以下文件复制到：

```text
<your-vault>/.obsidian/plugins/obsidian-semantix/
```

需要复制：

- `main.js`
- `manifest.json`

当前没有单独的 `styles.css` 文件。

## 与后端的契约

插件当前依赖以下接口：

- `GET /health`
- `GET /index/status`
- `POST /index/batch`
- `POST /index/delete`
- `POST /search/semantic`
- `POST /index/clear/request`
- `POST /index/clear/confirm`

说明：

- 全量索引不是后端单独任务，而是前端多次调用 `/index/batch`
- `vault_id` 由插件本地计算

## 当前实现注意事项

- 移动端默认休眠，除非用户在设置里显式开启
- `Exclusion Rules` 当前是路径前缀匹配，不是完整 glob
- `Explainable Results` 在 UI 中存在；当前后端本身就会返回 snippet

更完整的整体说明见 [root README](../README.md)。
