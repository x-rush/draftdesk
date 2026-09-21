# 参与社区版

欢迎报告可复现的问题、改进研究来源适配、补充 Skill 评测和提交界面修复。先阅读 README 的能力边界，较大变更先通过 issue 说明用户问题与预期行为。

## 本地验证

需要 Docker Desktop 或 Docker Engine + Compose。运行 `docker compose up -d --build`，访问 http://127.0.0.1:5173。

提交前运行：

```sh
docker compose run --rm worker npm test
docker compose run --rm worker npm run check
docker compose build
```

每个 PR 描述问题、修改和实际验证结果。新增来源应说明授权/访问方式、失效行为和数据口径；不要绕过登录或验证码。Skill 修改需提供失败案例与预期判断，模型评测未运行时明确说明，不能把格式检查当成内容质量证明。

数据、模型密钥、令牌、SQLite 数据库、真实聊天记录和本机验证文档不要提交。演示和测试请使用明确标注的虚构材料。保留第三方许可，新增依赖需说明用途。
