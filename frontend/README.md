# Semantix (语义雷达) Plugin for Obsidian

一款基于本地大模型与向量数据库的 Obsidian 侧边栏插件，自动发现笔记库中语义相近但缺乏显式链接的知识节点。

## 核心功能 (Core Features)

- **Real-time Whisperer (动态灵感)**
  根据您当前在编辑器中输入的内容（或正在阅读的段落全文），在右侧边栏实时推荐语义相似的历史笔记。
  - 支持防抖配置，避免频繁触发 API。
  - 支持双向链接过滤，隐藏已经建立链接的笔记。

- **Orphan Node Rescuer (游离笔记雷达)**
  一键扫描您的整个 Obsidian Vault，找出没有任何出度 (`links`) 和入度 (`backlinks`) 的“孤岛笔记”。
  点击任意孤岛笔记，即可展开查看为其推荐的语义相似笔记，帮助您将灵感碎片连接入网。

- **Incremental Sync (增量同步)**
  自动监听 Obsidian 的文件变更（创建、修改、重命名、删除），并将变更排入防抖队列，打包批量发送给本地向量数据库。

## 安装与开发步骤 (Development)

本项目使用 TypeScript 和官方的 Obsidian Plugin API 构建。

### 1. 环境准备
- Node.js (建议 >= 18)
- Obsidian 桌面版

### 2. 编译插件
```bash
# 安装依赖
npm install

# 开发模式（监听文件变化并自动重新编译）
npm run dev

# 生产环境编译（压缩并生成 main.js）
npm run build
```

### 3. 安装到 Vault
由于本插件需要配合专门的本地 FastAPI 后端运作，尚未提交至官方插件市场。
请将编译后的 `main.js`, `manifest.json` 和 `styles.css`（如有）直接拷贝到您的 Vault 插件目录下：
`<your-vault>/.obsidian/plugins/obsidian-semantix/`

然后在 Obsidian 设置的“第三方插件”中找到并启用 **Semantix**。

## 后端服务依赖
此插件必须连接到对应的 Python 向量服务（`semantix-backend`）。您可以在插件的设置面板中配置 `Backend API URL` 并点击“测试连接”。
完整的后端代码和架构文档，请参阅代码仓库根目录。
