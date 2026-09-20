# Twikoo EdgeOne Makers 版本

<a href="https://twikoo.js.org/"><img src="./docs/static/logo.png" width="300" alt="Twikoo"></a>

[![](https://img.shields.io/npm/l/twikoo)](./LICENSE)

专为腾讯云 EdgeOne Makers 平台优化的 [Twikoo](https://github.com/twikoojs/twikoo) 评论系统后端。

镜像仓库: [CNB](https://cnb.cool/Mintimate/code-nest/twikoo-eo)、[GitHub](https://github.com/Mintimate/twikoo-eo)

**简洁** · **安全** · **免费**

当前同步至 [Twikoo 1.7.24](https://github.com/twikoojs/twikoo/releases/tag/1.7.24)，建议前端也使用同版本。本次同步包含客户端字段类型校验、`HIDE_SPAM` 前台隐藏逻辑、最新评论纯文本转换，以及邮箱和链接的违禁词检测修复。`HIDE_SPAM=true` 时，作者和管理员也无法在前台看到垃圾评论，管理后台仍可审核。

## ⚠️ 破坏性更新说明

**存储后端已从 KV 迁移至 Blob，数据不会自动迁移。**

如果你是从旧版本（使用 KV 存储）升级，请在部署前完成以下步骤，否则历史评论数据将丢失：

1. **导出数据**：在旧版本的 Twikoo 管理面板中，进入「数据管理」→「导出」，下载评论备份文件（JSON 格式）。
2. **部署新版本**：按下方快速上手步骤完成部署（无需再绑定 KV，Blob 存储会自动初始化）。
3. **导入数据**：在新版本的 Twikoo 管理面板中，进入「数据管理」→「导入」，上传之前备份的文件。

---

## 特性

- 基于 EdgeOne Makers 边缘计算，全球加速
- 使用 Blob 对象存储，强一致性读写，无需额外配置
- 支持邮件通知、即时消息推送
- 一键部署，开箱即用

## 快速上手 | Quick Start

### 一键部署 | One-Click Deploy

您可以通过 [腾讯云 EdgeOne Makers](https://edgeone.ai/zh/document/69440) 一键部署。

直接点击此按钮一键部署：

[![使用 EdgeOne Makers 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?repository-url=https%3A%2F%2Fgithub.com%2FMintimate%2Ftwikoo-eo)

查看 [腾讯云 EdgeOne Makers 文档](https://edgeone.ai/zh/document/69440) 了解更多详情。

Blob 存储无需手动创建或绑定，首次请求时平台会自动初始化命名空间 `twikoo`。

### 完整教程 | Full Tutorial

Twikoo 的完整教程，参考 Twikoo 官方项目: https://github.com/twikoojs/twikoo 以及 Twikoo 的[快速上手](https://twikoo.js.org/quick-start.html)

手动部署到 EdgeOne Makers 的方法如下：

#### 部署步骤 | Deployment Steps

1. **准备工作**
   - 注册腾讯云账号并开通 EdgeOne 服务

2. **创建 EdgeOne Makers 项目**
   - 登录腾讯云 EdgeOne 控制台
   - 创建新的 Makers 项目
   - 选择 GitHub 作为代码源
   - 关联本仓库。或者直接下载本仓库，手动上传到 EdgeOne Makers（会自动触发部署）。

3. **配置跨域（可选）**
   - 在 EdgeOne Makers 控制台添加环境变量 `CORS_ALLOW_ORIGIN`
   - 格式：`example.com,blog.example.com`（多个域名用逗号分隔）
   - 不设置则允许所有域名访问

4. **触发部署**
   - 三种方法触发部署：① Fork 代码到自己仓库，EdgeOne Makers 进行关联，后续会自动触发部署。② 本地安装 EdgeOne CLI 后，执行 `edgeone makers link`、`edgeone makers deploy`。③ 手动上传代码到 EdgeOne Makers。
   - 部署完成后，获取你的 EdgeOne Makers 地址作为 Twikoo 的环境配置

5. **前端配置**
   ```html
   <script>
     twikoo.init({
       envId: 'your-edgeone-makers-url',  // EdgeOne Makers 地址
       el: '#tcomment'
     })
   </script>
   ```

#### 环境配置要求 | Environment Requirements

- **Node.js**: 20.x（EdgeOne Makers 自动提供）
- **Blob 存储**: 无需手动配置，平台自动初始化

### 自定义 SMTP

EdgeOne Makers 的 Node Function 运行时不支持 TCP socket。自定义 SMTP 由 `cloud-functions/smtp.go` 这个 Go Cloud Function 连接邮件服务器，Node Function 通过同项目的 `/smtp` Bridge 调用它。

1. 在 EdgeOne Makers 环境变量中配置 `TWIKOO_SMTP_BRIDGE_TOKEN`，建议使用随机长字符串。该变量用于保护 `/smtp` Bridge，并不是 SMTP 密码。可使用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。
2. 在 Twikoo 管理面板中配置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`SENDER_EMAIL`。
3. 465 端口通常配置 `SMTP_SECURE=true`；587 端口通常配置 `SMTP_SECURE=false`。
4. 不要同时配置 `SMTP_SERVICE`。`SMTP_SERVICE=SendGrid` 或 `SMTP_SERVICE=MailChannels` 会继续使用对应的 HTTP API，不经过 Go SMTP Bridge。

#### 常见问题解决方法 | Common Issues

1. **评论提交后刷新看不到**
   - 已使用强一致性读写（`consistency: "strong"`），正常情况下提交后立即可见
   - 若仍有问题，检查 Cloud Function 日志排查 Blob 写入错误

2. **邮件通知不工作**
   - 验证 SMTP 服务配置是否正确；使用自定义 SMTP 时确认 `TWIKOO_SMTP_BRIDGE_TOKEN` 已配置
   - 检查邮箱是否开启了 IMAP/SMTP 服务
   - 确认邮箱密码或应用专用密码

3. **评论提交失败**
   - 检查网络连接和 Cloud Function 地址
   - 查看部署日志排查错误

#### 注意事项 | Important Notes

当前测试以下功能正常:
- 评论提交、评论回复、评论点赞、评论删除等前台评论操作。
- 邮件通知（支持 SendGrid、MailChannels 和自定义 SMTP Bridge）。
- IP 获取正常（使用 EdgeOne 提供的 `eo-connecting-ip`）。
- UA 获取、浏览器类型正常。
- IP 归属地查询正常。

Blob 存储的评论:

![Blob 存储的评论](./docs/static/eoBlobComments.png)

## 开发 | Development

### EdgeOne Makers 开发 | EdgeOne Makers Development

本项目结构专为 EdgeOne Makers 平台优化：

``` sh
# 安装 EdgeOne CLI (在 CloudStudio 中已预装)
npm install -g edgeone

# 本地开发调试
edgeone makers dev

# 项目检查
node build.cjs

# 本地接口回归测试（使用内存 Blob，不连接线上存储）
npm test
```

**项目结构说明：**
```
├── cloud-functions/
│   ├── index.js               # Node Function 主入口（含 Blob 数据库层）
│   ├── smtp.go                # Go SMTP Bridge（自定义 SMTP 发信）
│   ├── ip2region-searcher.js  # IP 归属地查询器（纯内存实现）
│   └── ip2region-data.js      # IP 数据库（构建时自动生成）
├── package.json               # 项目依赖配置
└── build.cjs                  # 构建检查脚本
```

**架构说明：**
- **Cloud Function (`cloud-functions/index.js`)**: 运行在 Node.js 环境，处理评论业务逻辑、邮件通知，并直接通过 `@edgeone/pages-blob` SDK 读写 Blob 存储
- **SMTP Bridge (`cloud-functions/smtp.go`)**: 运行在 Go 环境，通过受令牌保护的 `/smtp` 路由提供 SMTP 连接能力
- Blob 命名空间为 `twikoo`，使用强一致性模式，确保评论写入后立即可读

如果您的改动能够帮助到更多人，欢迎提交 Pull Request！

## 许可 | License

<details>
<summary>MIT License</summary>

[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fimaegoo%2Ftwikoo.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2Fimaegoo%2Ftwikoo?ref=badge_large)

</details>
