# internal/app

这里是新的 Go 后端主线：

- `config.go`：环境变量配置
- `models.go`：领域模型
- `store.go`：MySQL 存储与 migration
- `server.go`：Gin 路由与 handlers

目标：逐步替换旧的 `server.mjs` Node 后端。
