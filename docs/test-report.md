# vmagent-ui 测试说明

> 本文档已按 VictoriaMetrics 官方 vmagent 文档口径修正：UI 负责配置管理、版本、审计与发布编排；vmagent 自身的分布式/分片/复制能力以官方参数和部署方式为准。

## 测试目标

验证 MVP 是否具备基础可运行性：

- 页面可正常打开
- 能加载示例 vmagent YAML
- 能显示 JSON 预览
- 能显示版本历史与审计区块
- 能执行服务端校验接口
- 能生成页面截图

## 测试环境

- Node.js 本地运行
- 浏览器：Playwright Chromium
- 示例配置：`config/sample-vmagent.yml`

## 执行步骤

```bash
cd vmagent-ui
npm install
npm start
# 另一个终端
npm run test:screenshot
```

## 结果

- Web 页面可访问：`http://127.0.0.1:3099`
- `GET /api/health` 返回成功
- `POST /api/validate` 对示例配置返回通过
- `POST /api/publish` 已成功生成一条 demo revision 与审计记录
- UI 主要区域已渲染：状态卡、YAML 编辑器、JSON 预览、校验结果、版本历史、审计日志
- 已生成截图文件：`docs/vmagent-ui-screenshot.png`

## 说明

如果机器上未安装 `vmagent`，原生 `-dryRun` 检查会自动跳过，但 YAML 结构和基础业务规则校验仍可执行。

生产接入时，只需补充以下环境变量即可：

- `VMAGENT_CONFIG_PATH`
- `VMAGENT_RELOAD_URL` 或 `VMAGENT_PID`
- 必要时 `VMAGENT_RESTART_CMD`
