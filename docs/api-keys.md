# 密钥获取与配置指南（百炼 · Tavily）

工作台有两个第三方密钥：**百炼 API Key**（必需，模型调用）和 **Tavily API Key**（可选，网页搜索与定向补证）。两者都由你自己注册申请、自己承担费用；工作台不代管账号，也不内置任何共享密钥。

> 不要混淆：这里需要的是**百炼 API Key**（`sk-` 开头），不是阿里云 RAM 的 AccessKey ID / Secret（`LTAI` 开头）。后者是云资源控制台凭据，工作台用不到。

## 百炼 API Key（模型调用，必需）

**获取步骤**

1. 打开[阿里云百炼控制台](https://bailian.console.aliyun.com)，用阿里云账号登录。
2. 首次使用按提示**开通模型服务**（模型按量计费，各模型价格以控制台为准；不预设免费额度）。
3. 进入 **API-KEY 管理**（控制台左侧），点**创建 API Key**，复制 `sk-` 开头的 Key。
4. 记下你的 **Base URL**，二选一：
   - 官方兼容模式：`https://dashscope.aliyuncs.com/compatible-mode/v1`；
   - 专属 Endpoint：在开通页查看，形如 `https://<你的ID>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。
   两种都行；服务端只接受 `*.cn-beijing.maas.aliyuncs.com`（北京地域专属 Endpoint）或 `dashscope.aliyuncs.com` 的 HTTPS 地址，其他域名不被校验通过。
5. 确认**模型名**：在百炼「模型广场」查看你账号已开通的模型 ID（如 `qwen3.8-flash`）。模型名以自己账号实际可用为准，`.env.example` 里的只是示例。

**填写位置（二选一）**

- **方式 A · 页面填写（推荐）**：工作台左侧「研究与设置 → 模型与设置」，填 Base URL、模型名、API Key，保存后点「测试模型连接」，看到「连接成功」即通。密钥保存在本机 `data/draftdesk.sqlite`，不出现在 JSON 导出和 Git 仓库里。
- **方式 B · 环境变量**：在项目根目录建 `.env`（已被 .gitignore 排除），写入：

  ```sh
  DRAFTDESK_AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
  DRAFTDESK_AI_MODEL=qwen3.8-flash
  DRAFTDESK_AI_API_KEY=sk-你的密钥
  ```

  然后 `docker compose up -d` 重启生效。**注意优先级**：环境变量存在时覆盖页面保存的值；排障时先确认 `.env` 里没有旧值。

## Tavily API Key（网页搜索，可选）

不填也能用：热榜、RSS、官方活动采集、外部证据导入都不依赖 Tavily。需要「每日发现」里的网页搜索和定向补证时才填。

**获取步骤**

1. 打开 [app.tavily.com](https://app.tavily.com)，注册并登录。
2. 在 API Key 页复制 `tvly-` 开头的 Key（免费档每月含 basic 搜索额度，额度与价格以官网为准）。

**填写位置**：「模型与设置」同页粘贴 Tavily Key，保存后点「测试搜索」——会真实消耗 1 次 basic 额度，返回「实际搜索成功」即通。Tavily Key 建议页面填写；环境变量方式需自行在 `compose.yaml` 的 app 与 worker 环境中补 `TAVILY_API_KEY` 透传。

## 常见报错对照

| 现象 | 原因与处理 |
| --- | --- |
| 提示「请填写百炼专属 Base URL」 | Base URL 没填，或不是百炼 / dashscope 域名 |
| 百炼请求失败（HTTP 401） | API Key 无效或已删除；回百炼控制台重建，页面粘贴新 Key 覆盖 |
| 保存配置时被拒 | Base URL 域名不匹配（只收 `*.cn-beijing.maas.aliyuncs.com` 或 `dashscope.aliyuncs.com`，需 `https` 且以 `/compatible-mode/v1` 结尾）；注意北京地域以外的专属 Endpoint 当前不被接受 |
| 模型连接成功但任务报「模型输出…」 | 密钥没问题，是模型输出质量或预算问题，见 README「研究质量」 |
| 测试搜索失败 | Tavily Key 无效或免费额度用尽；官网确认后换 Key |

## 安全边界

- 两把 Key 只保存在本机 `data/` 目录；**JSON 工作数据导出不含密钥**；完整备份时 `data/` 目录是敏感文件，不要外传。
- `.env` 已被 `.gitignore` 排除，不要把 Key 写进其他文件或提交仓库。
- 密钥疑似泄露：去百炼 / Tavily 控制台删除旧 Key 重建，工作台页面粘贴新值覆盖保存。
- 外部 Agent 只拿**提交令牌**（工作台「外部接入」页生成），向导提示词不包含模型密钥；也不要把工作台密钥配置进 Agent 环境。
