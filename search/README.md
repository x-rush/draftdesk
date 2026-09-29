# DraftDesk SearXNG

本地自托管的网页搜索后端，随主 `compose.yaml` 一并启动，无需单独部署。
工作台容器经项目内网以 `http://searxng:8080` 访问；不发布宿主机端口，
不包含模型密钥或工作台提交令牌。

## 配置

- `settings.yml` 是唯一配置来源（只读挂载进容器）。已放行 `format=json`
  输出（混合搜索与「测试搜索」依赖它），并关闭限流器以适配本机容器间调用。
- 默认启用 bing / brave / duckduckgo / google / wikipedia 引擎，可按需增删。

## 验证

```sh
docker compose ps searxng
docker compose exec worker node -e "fetch('http://searxng:8080/search?format=json&q=AI').then(r=>r.json()).then(j=>console.log(j.results.length))"
```

SearXNG 是独立的 AGPL-3.0 服务。再分发或基于它对外提供网络服务时，请保留其
源码与许可声明。
