# AMZ Daily Digest — 亚马逊卖家每日资讯聚合

自动采集亚马逊卖家社区资讯，AI 筛选摘要，每日邮件推送。

## 特点

- **全自动**: GitHub Actions 每日定时执行，无需服务器
- **$0/月**: 全部使用免费额度 (GitHub Actions + Supabase + Gmail SMTP + Gemini)
- **知无不言优先**: Playwright 登录爬取，确保最重要的中文卖家社区全覆盖
- **AI 智能筛选**: Gemini Flash 打分 + 摘要 + 分类，只推送高相关度内容

## 信息源

| 源 | 方法 | 优先级 |
|-----|------|--------|
| 知无不言 | Playwright + cookie 登录 | P0 |
| AMZ123 | RSS (RSSHub) | P1 |
| Reddit r/FBA | JSON API | P1 |
| Reddit r/AmazonSeller | JSON API | P1 |
| Seller Central 论坛 | Playwright | P2 |

## 快速开始

### 1. 安装依赖

```bash
npm install
npx playwright install chromium --with-deps
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的 API keys
```

### 3. Supabase 建表

在 Supabase SQL Editor 执行 PLAN.md 中的建表 SQL。
然后执行迁移文件：

```sql
-- supabase/migrations/20260217_0001_p0_foundation.sql
-- supabase/migrations/20260219_0002_backup_dispatch_scheduler.sql
```

### 4. 本地测试

```bash
npx tsx src/main.ts
```

质量检查：

```bash
npm run check
npm run check:ci
```

### 5. 本地运行运维看板（Next.js）

```bash
npm run web:dev
```

打开 `http://localhost:3000` 可查看：
- 运行看板 `/dashboard`
- 历史日报 `/digests`
- 订阅管理 `/subscribers`

### 6. 部署到 GitHub Actions

1. 在 GitHub repo Settings → Secrets 中添加所有环境变量
2. 知无不言 cookie: 手动登录后导出 cookie JSON，存为 `WEARESELLERS_COOKIES` secret
3. Push 代码，Actions 会在每天 06:00 UTC 自动执行
4. 也可在 Actions 页面手动触发 (workflow_dispatch)

### 7.（强烈建议）开启 Supabase 兜底调度

> 目标：当 GitHub `schedule` 偶发延迟/漏触发时，Supabase 仍会自动触发 `workflow_dispatch`，保证不断更。

#### 7.1 先在 Supabase Vault 写入 5 个密钥

在 Supabase SQL Editor 执行（把 `<...>` 替换成你的实际值）：

```sql
select vault.create_secret('Wekhoh', 'github_repo_owner');
select vault.create_secret('AMZ-Daily-Digest-', 'github_repo_name');
select vault.create_secret('daily-digest.yml', 'github_workflow_file');
select vault.create_secret('main', 'github_dispatch_ref');
select vault.create_secret('<GITHUB_TOKEN_WITH_ACTIONS_WRITE>', 'github_dispatch_token');
```

#### 7.2 执行迁移（创建兜底调度）

```sql
-- supabase/migrations/20260219_0002_backup_dispatch_scheduler.sql
```

#### 7.3 验证是否生效

```sql
-- 查看定时任务
select jobid, jobname, schedule, active
from cron.job
where jobname like 'amz-digest-backup-%'
order by jobname;

-- 查看兜底触发日志
select *
from public.digest_dispatch_logs
order by triggered_at desc
limit 20;
```

说明：
- 兜底任务时间：`06:08 UTC` 与 `06:18 UTC`（洛杉矶冬令时 `22:08/22:18 PST`）。
- 如果主调度已经成功发送，当天兜底触发会因幂等性自动跳过，不会重复发邮件。

## 项目结构

```
src/
├── collectors/
│   ├── wearesellers.ts   # 知无不言爬虫 (P0)
│   ├── rss.ts            # AMZ123 RSS
│   ├── reddit.ts         # Reddit JSON
│   └── sellercentral.ts  # Seller Central 爬虫 (P2)
├── config.ts             # 集中配置常量
├── utils.ts              # 共享工具 (SSRF 防护, sleep)
├── process.ts            # Gemini AI 处理
├── store.ts              # Supabase 读写
├── email.ts              # Gmail SMTP 邮件
└── main.ts               # 入口编排
templates/
└── email.html            # 邮件模板
.github/workflows/
├── ci.yml                # PR/Push 质量门禁 (typecheck/lint/coverage)
└── daily-digest.yml      # 定时任务
app/
├── page.tsx              # 控制台首页
├── dashboard/page.tsx    # 运行看板
├── digests/page.tsx      # 历史日报
└── api/                  # 运维 API
supabase/migrations/
└── 20260217_0001_p0_foundation.sql
└── 20260219_0002_backup_dispatch_scheduler.sql
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `GEMINI_API_KEY` | Google AI Studio 获取 |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_KEY` | Supabase service role key |
| `GMAIL_USER` | Gmail 发件邮箱 |
| `GMAIL_APP_PASSWORD` | Gmail 应用专用密码 |
| `DIGEST_EMAIL` | 接收摘要的邮箱 |
| `WEARESELLERS_COOKIES` | 知无不言登录 cookie (JSON) |

## 技术栈

Node.js 20 + TypeScript (tsx) / Playwright / Supabase / Gemini Flash / nodemailer (Gmail SMTP)

## 详细计划

见 [PLAN.md](./PLAN.md)
