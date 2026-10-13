# Twikoo EdgeOne Makers 增强版

<a href="https://twikoo.js.org/"><img src="./docs/static/logo.png" width="300" alt="Twikoo"></a>

[![](https://img.shields.io/npm/l/twikoo)](./LICENSE)

基于 [Twikoo 2.0.13](https://github.com/twikoojs/twikoo/releases/tag/2.0.13) 的 EdgeOne Makers 后端，当前仓库版本为 **2.0.13-eo.1**。通过仓库或 CLI 部署，复用官方评论业务，并保留适合本项目的增强功能。

镜像仓库：[CNB](https://cnb.cool/Mintimate/code-nest/twikoo-eo)、[GitHub](https://github.com/Mintimate/twikoo-eo)。本仓库只提供后端，前端请配套使用 Twikoo **2.0.13**。

## 升级与数据兼容

### 从本仓库 Blob 版 1.7.24 升级

**沿用同一个 Makers 项目和存储环境时，无需迁移数据。** 本次没有更换 Blob 存储、命名空间或记录格式：

| 数据 | 现有位置 |
| --- | --- |
| Blob 命名空间 | `twikoo`，`consistency: 'strong'` |
| 全部评论 | `comments:all` |
| 配置与管理员密码 | `config:main` |
| 访问计数 | `counter:${encodeURIComponent(url)}` |
| 内嵌 Cap | `cap:c:*`、`cap:t:*` |

已有管理员密码、访客 token、评论归属和未过期的 Cap token 均沿用。新建 Makers 项目不会自动获得旧项目的数据。

升级前保留当前部署版本和数据备份，先在独立测试项目验证评论、后台登录、验证码及通知，再更新正式部署和前端。管理面板的评论导出只包含评论；配置、访问计数需要另外备份，不能把评论 JSON 当作完整 Blob 备份。

请继续通过本仓库更新增强版。官方 Makers ZIP 是另一种部署产物，直接覆盖会失去本仓库的增强和构建流程。

### 更早的 KV 版本

仅当旧部署仍使用 KV 时，才需要完成之前的 KV → Blob 迁移。旧 KV 数据不会被当前版本自动读取：

1. 在旧后台「数据管理 → 导出」保存评论 JSON，同时保存配置和需要保留的访问计数。
2. 部署本仓库，初始化 Blob 环境和后台配置。
3. 在新后台「数据管理 → 导入」选择 Twikoo 备份，恢复评论。评论导入不会恢复配置和访问计数。

## 复用范围与增强

| 范围 | 实现方式 |
| --- | --- |
| 评论、回复、鉴权、配置、赞踩、导入导出、统计、验证码、推送 | 复用 `@twikoojs/common@2.0.13` 官方业务 |
| Blob 存储 | 直接使用官方 `BlobKvDatabase`，保留现有键和文档结构 |
| 服务端内容过滤 | 使用 `xss`，覆盖提交、管理员编辑和导入的评论内容 |
| `HIDE_SPAM` | 开启后作者和管理员在前台也看不到垃圾评论；后台仍能审核 |
| 前台线程搜索 | 匹配可见回复时保留所属主楼，继续遵循评论可见性 |
| 列表兼容修正 | 关闭置顶时保留历史置顶评论；按赞数计算热度并在排序后分页 |
| 邮件 | SendGrid / MailChannels HTTP API，以及现有 Go SMTP Bridge |
| IP 属地 | 构建时内联 ip2region 数据，运行时在内存中查询 |
| Akismet / LLM 审核 | 保留官方审核流程，注入适合 Makers 的 HTTP 依赖 |

这些通用业务大多已存在于上游或本仓库 1.x，并非本次新增功能。本次主要变化是将重复的业务实现交给官方，保留小范围平台适配和增强。

当前通过官方 `@twikoojs/common` 的公开接口装配服务，**不直接依赖 `@twikoojs/edgeone-makers` 的封闭 bundle**。官方 EO 包内联了自己的公共层，外部另外加载 common 时，两者的注册表与依赖注入不会共享。采用公开接口可以继续复用核心业务，同时注入过滤、审核、邮件和数据库视图。

## 部署

### 仓库部署

[![使用 EdgeOne Makers 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?repository-url=https%3A%2F%2Fgithub.com%2FMintimate%2Ftwikoo-eo)

也可以 Fork 本仓库，在 Makers 控制台关联自己的仓库。项目使用以下构建配置：

- 构建命令：`npm run build`
- 静态输出目录：`public`
- 云函数目录：`cloud-functions`

上述构建和静态目录配置保存在 `edgeone.json`。`public` 只放 favicon 等公开资源，不将仓库根目录作为静态站点发布。构建会生成 Node 函数所需的 `dist/twikoo.js`，部署时保留 `cloud-functions/smtp.go`。

Blob 无需手动绑定 KV，首次业务请求通过平台 SDK 打开 `twikoo` 命名空间。GET / HEAD 健康检查不会初始化存储。

平台操作说明见 [EdgeOne Makers 文档](https://edgeone.ai/zh/document/69440)。

### CLI 部署与本地开发

构建要求 **Node.js ≥ 20.19.0**，当前本地验证使用 Node.js 24。Makers CLI 完整构建 Go SMTP 函数还需要本机安装 Go 工具链。

```sh
# 安装 EdgeOne CLI，并按 CLI 提示登录
npm install -g edgeone

# 按 lockfile 安装；postinstall 自动生成函数 bundle
npm ci

# 构建、源码测试和部署 bundle 测试
npm run check

# 将 PROJECT 替换为你的 Makers 项目名
npm run dev -- -n PROJECT

# 完成检查后部署到指定项目
npm run deploy -- -n PROJECT
```

不要省略构建所需的开发依赖：esbuild 和 ip2region 原始数据库在 `devDependencies` 中。`npm run build` 负责 Node 函数产物，Go 函数由 Makers 构建流程处理。

### 前端

将环境地址填写为后端的完整 HTTPS 地址：

```html
<div id="tcomment"></div>
<script src="https://cdn.jsdelivr.net/npm/twikoo@2.0.13/dist/twikoo.min.js"></script>
<script>
  twikoo.init({
    envId: 'https://your-makers-domain.example',
    el: '#tcomment'
  })
</script>
```

更多主题接入方式见 [Twikoo 前端配置](https://twikoo.js.org/frontend.html)。

## 环境变量与跨域

| 环境变量 | 用途 |
| --- | --- |
| `CORS_ALLOW_ORIGIN` | 可选，覆盖后台的跨域白名单，多个 Origin 用逗号分隔 |
| `TWIKOO_SMTP_BRIDGE_TOKEN` | 自定义 SMTP 必需，Node 与 Go Bridge 共用的随机长令牌 |
| `TWIKOO_SMTP_BRIDGE_URL` | 可选，显式指定本项目可信的公开 Bridge 地址，例如 `https://comments.example.com/smtp` |

跨域配置推荐填写完整 Origin，例如 `https://example.com,https://blog.example.com`。兼容旧文档中的裸域名写法，`example.com` 会按 `https://example.com` 处理。允许本地 `localhost` 开发请求。

`CORS_ALLOW_ORIGIN` 环境变量只覆盖当前请求读取到的配置视图，**不会写回 Blob**。未设置环境变量时使用后台配置；两处均未配置时，允许携带 Origin 的跨域请求。上述 CORS 和 SMTP 变量以平台 `context.env` 为优先来源。

其他 Twikoo 设置仍在管理面板中配置，不能通过随意添加同名环境变量替代。官方核心的 `TWIKOO_THROTTLE`、`TWIKOO_LOG_LEVEL` 仅读取进程环境 `process.env`，其中日志级别在启动时读取；本适配层不会将这两项 `context.env` 配置写入全局进程环境。

## 邮件与审核

### 自定义 SMTP

Makers Node Function 的 SMTP 连接通过 `cloud-functions/smtp.go` 完成：Node 使用 HTTP 调用同项目 `/smtp`，Go 连接 SMTP 服务器。本次保留已有 Go Bridge。

1. 在项目环境变量中配置 `TWIKOO_SMTP_BRIDGE_TOKEN`，供 Node 与 Go 函数读取。它是 Bridge 令牌，不是邮箱密码。可用下面的命令生成：

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. 在后台配置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`SENDER_EMAIL`。
3. 465 通常使用 `SMTP_SECURE=true`，587 通常使用 `SMTP_SECURE=false`，以邮件服务商要求为准。
4. 如果实际传入函数的 `request.url` 是平台内部地址，配置 `TWIKOO_SMTP_BRIDGE_URL=https://你的公开后端域名/smtp`。

Bridge 自动发现只信任实际请求 URL 的同源地址。客户端 `envId` 和 `Origin` 只有同源时才参与候选；跨源目标必须由部署环境中的 `TWIKOO_SMTP_BRIDGE_URL` 显式指定。探测使用随机 nonce 和 HMAC 校验，通过后才发送 Bridge 令牌与 SMTP 凭据，探测和发信请求均不跟随重定向。URL 不接受用户名或密码。

使用 SendGrid 或 MailChannels 时，清空 `SMTP_HOST` 并设置对应 `SMTP_SERVICE`，通过 HTTP API 发信，无需 Go Bridge 令牌。如果同时配置，`SMTP_HOST` 优先。

### 反垃圾与验证码

人工审核、屏蔽词、违禁词、Turnstile、Geetest、内外部 Cap 均沿用官方流程。Akismet 配置 `AKISMET_KEY` 和完整的 `SITE_URL`；LLM 配置 `LLM_API_KEY`、`LLM_API_ENDPOINT`、`LLM_MODEL` 等后台选项。

Akismet 与 LLM 使用官方的选择顺序，并非同时运行两个审核器。**腾讯云 TMS 当前未启用**。`HIDE_SPAM=true` 会隐藏前台待审核内容，提交后看不到时可先检查后台审核列表。

## 开发与验证

```text
├── src/
│   ├── handler.js             # 请求规范化、官方核心装配、能力与依赖注入
│   ├── enhancements.js        # 内容过滤、HIDE_SPAM、线程搜索与列表修正
│   ├── mail.js                # HTTP 邮件和可信 SMTP Bridge
│   ├── akismet.js             # Akismet 原生 fetch 传输
│   ├── ip2region.js           # 纯内存属地查询
│   └── generated/             # 构建生成的压缩 IP 数据
├── cloud-functions/
│   ├── index.js               # Makers Node 入口，加载 dist/twikoo.js
│   └── smtp.go                # Go SMTP Bridge
├── dist/                      # 构建产物，不手工修改
├── public/                    # 仅公开静态资源
├── tests/                     # 内存 Blob 与模拟 HTTP 回归
├── edgeone.json               # Makers 构建配置
└── build.cjs                  # 打包、内联数据与依赖完整性检查
```

`npm run check` 验证源码和部署 bundle。兼容测试直接使用 1.7.24 形态的 Blob 数据，检查管理员/访客 token、评论回复、导入导出、访问计数、Cap、内容过滤、跨域和属地查询；邮件与第三方审核通过模拟 HTTP 验证请求和响应处理。

本地回归使用内存 Blob 和模拟 HTTP，不使用真实邮箱、审核服务或线上数据。平台打包可执行 `edgeone makers build --mode prod`，检查 Node 和 Go 两类函数；部署后再验证该项目的邮件与审核配置。

## 已知限制

- Blob 仍将评论整表保存在 `comments:all`。官方数据库在修改前重新读取，但没有 CAS 或事务；强一致性不等于读改写原子性，并发写入仍可能覆盖。
- 审核和通知在评论保存后异步执行。运行时提供 `waitUntil` 时交由平台托管；没有 `waitUntil` 时沿用进程内后台执行，不能保证函数响应后任务一定完成。
- 当前属地数据使用 IPv4 数据库；无法匹配的地址可返回空属地。
- Node 构建与模拟接口检查不替代 Makers 实际部署、Go 函数构建或真实第三方服务验证。

## 许可

[MIT License](./LICENSE)。Twikoo 及复用的上游实现版权归其原作者所有。
