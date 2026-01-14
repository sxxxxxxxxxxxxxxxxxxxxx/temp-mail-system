# 临时邮箱系统 v2.0

基于 Cloudflare Workers + D1 + Email Routing 的临时邮箱系统。

## 支持的域名

- 2art.fun
- sumeetsxiang.com
- wadao.world
- wearwave.live

## 工作原理

```
发件人 → Cloudflare Email Routing → Cloudflare Worker → D1 数据库 → 前端展示
```

## 部署步骤

### 1. 安装依赖

```bash
cd temp-mail-system
npm install
```

### 2. 创建 D1 数据库

```bash
npm run db:create
```

执行后会输出类似：

```
Created D1 database 'temp-mail-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. 更新配置

复制 `wrangler.toml.example` 为 `wrangler.toml`，并将 `database_id` 替换为上一步输出的值：

```bash
cp wrangler.toml.example wrangler.toml
```

然后编辑 `wrangler.toml`，更新 `database_id` 和 `DOMAINS`。

### 4. 初始化数据库

```bash
npm run db:migrate
```

### 5. 部署 Worker

```bash
npm run deploy
```

部署成功后会输出 Worker URL，例如：`https://temp-mail.your-account.workers.dev`

### 6. 绑定自定义域名（可选）

在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Triggers → Custom Domains 中添加自定义域名。

### 7. 配置 Email Routing（重要！）

对于每个支持的域名：

1. 进入 Cloudflare Dashboard → 选择域名
2. 点击 **Email** → **Email Routing**
3. 启用 Email Routing
4. 点击 **Routing rules** → **Catch-all address**
5. 选择 **Send to a Worker**
6. 选择你部署的 Worker（temp-mail）
7. 保存

## 本地开发

```bash
# 初始化本地数据库
npm run db:migrate:local

# 启动开发服务器
npm run dev
```

## API 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/domains` | GET | 获取支持的域名列表 |
| `/api/generate` | GET | 生成随机邮箱地址 |
| `/api/inbox?address=xxx` | GET | 获取收件箱邮件列表 |
| `/api/message?address=xxx&id=xxx` | GET | 获取邮件详情 |
| `/api/attachment?id=xxx` | GET | 下载附件 |
| `/api/delete?address=xxx&id=xxx` | GET | 删除邮件 |

## 项目结构

```
temp-mail-system/
├── src/
│   ├── index.js          # Worker 主入口
│   ├── email.js          # 邮件处理逻辑
│   └── utils.js          # 工具函数
├── public/
│   └── index.html        # 前端页面
├── migrations/
│   └── 0001_init.sql     # 数据库初始化
├── wrangler.toml.example # Cloudflare 配置示例
└── package.json
```

## 注意事项

1. **Email Routing 必须配置**：没有配置 Email Routing，Worker 无法接收邮件
2. **域名必须托管在 Cloudflare**：Email Routing 只支持 Cloudflare 托管的域名
3. **免费套餐限制**：
   - Workers：每天 100,000 请求
   - D1：每天 5GB 读取，100MB 写入
   - Email Routing：无限制

## 常见问题

### Q: 为什么收不到邮件？

1. 检查 Email Routing 是否已启用
2. 检查 Catch-all 规则是否指向正确的 Worker
3. 检查 Worker 日志是否有错误

### Q: 如何添加新域名？

1. 将域名托管到 Cloudflare
2. 修改 `wrangler.toml` 中的 `DOMAINS` 变量
3. 重新部署 Worker
4. 为新域名配置 Email Routing

### Q: 邮件存储多久？

目前没有自动清理，邮件会一直保留在 D1 数据库中。如需定期清理，可以添加 Cron Trigger。
