# vmagent-ui

一个面向 vmagent 的轻量 Web 配置管理界面 MVP，支持：

- 读取当前 YAML 配置
- YAML / JSON 双视图
- 服务端校验
- revision 历史
- 发布与回滚
- 审计日志
- 可选 reload / restart 接口编排

## 快速开始

```bash
cd vmagent-ui
npm install
npm start
```

默认访问：`http://127.0.0.1:3099`

## 环境变量

- `PORT`：服务端口，默认 `3099`
- `VMAGENT_CONFIG_PATH`：vmagent 主配置文件路径
- `VMAGENT_BIN`：vmagent 二进制路径，默认 `vmagent`
- `VMAGENT_RELOAD_URL`：例如 `http://127.0.0.1:8429/-/reload`
- `VMAGENT_PID`：如果要用 `SIGHUP`
- `VMAGENT_RESTART_CMD`：例如 `systemctl restart vmagent`
- `DEFAULT_AUTHOR`：默认操作者名

## 工作流

1. 读取当前草稿配置
2. 编辑 YAML 或 JSON
3. 点击“校验”执行：
   - YAML 解析
   - 基础业务规则
   - vmagent `-dryRun`（如果本机有 vmagent）
4. 点击“发布”后：
   - 生成 revision
   - 原子写入目标文件
   - 执行 reload / SIGHUP / restart（按配置优先级）
   - 写入审计日志

## 目录

- `server.mjs`：Fastify API + 静态页面服务
- `public/`：前端页面
- `config/sample-vmagent.yml`：示例配置
- `data/revisions/`：版本快照
- `data/audit/`：审计日志
- `docs/`：测试截图与说明文档

## 当前 MVP 边界

这版是务实原型，不是完整生产版。当前还没有：

- 登录 / RBAC
- 注释保留型 YAML AST 编辑
- 多文件联动编辑
- 精细化 diff 视图
- 真正的 systemd / docker / k8s 适配层

但已经具备“能跑、能看、能改、能校验、能留档、能发布”的主闭环。
