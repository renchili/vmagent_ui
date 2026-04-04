# Deprecated Node Backend

仓库里仍然保留以下旧实现：

- `server.mjs`
- `lib/*.mjs`
- `package.json`（Node/Fastify 相关）

这些文件现在的定位是：

- **过渡期参考实现**
- 用来对照旧逻辑
- 方便继续把残余细节迁到 Go

它们 **不再是主后端**。

当前主后端是：

- `cmd/server/main.go`
- `internal/app/*`

## 规则

- 新功能优先落到 Go 后端
- 修复优先修 Go 后端
- Node 侧除非是为了辅助迁移，否则不再继续演化
- `npm start` 已经切到 Go 后端启动脚本
- 旧 Node 启动只能显式使用：`npm run start:node-deprecated`

## 计划

等前端端到端联调完全稳定后：

1. 把 `server.mjs` 明确停用
2. 清理或归档 `lib/*.mjs`
3. 再决定是否保留 `package.json` 仅用于前端/脚本，或彻底移除旧 Node 后端依赖
