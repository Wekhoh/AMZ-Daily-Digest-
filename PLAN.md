# AMZ Daily Digest — 实施计划

> 最后更新: 2026-02-20
> 状态: v1.1 收尾中（自动化与可观测性加固）

## 方案概要

GitHub Actions 全 Serverless，$0/月，知无不言最高优先。

## 架构

```
[GitHub Actions Cron 每日 06:00 UTC]
    │
    ├── Playwright → 知无不言 (登录爬取，P0)
    ├── fetch → AMZ123 (RSSHub 公共实例)
    ├── fetch → Reddit JSON API (r/FBA + r/AmazonSeller)
    └── Playwright → Amazon Seller Central 论坛
            │
            v
    [Gemini Flash: 打分 + 中文摘要 + 分类 + 去重]
            │
            v
    [Supabase: 存储全部文章]
            │
      ┌─────┴─────┐
      v            v
  [Gmail SMTP]  [GitHub Pages]
  (nodemailer)  (可浏览历史日报)
```

## 月成本: $0

| 服务 | 用量 | 免费额度 |
|------|------|----------|
| GitHub Actions | ~20 min/天 | 2000 min/月 |
| Supabase | ~50 条/天 | 500MB / 50K 行 |
| Gmail SMTP | 1 封/天 | 500 封/天 (App Password) |
| Gemini Flash | ~100 call/天 | 1000 RPD |

## 信息源

| 优先级 | 源 | 方法 |
|--------|-----|------|
| **P0** | **知无不言** | Playwright + 登录 cookie |
| P1 | AMZ123 | fetch RSS (rsshub.app) |
| P1 | Reddit FBA | fetch JSON |
| P1 | Reddit Seller | fetch JSON |
| P2 | Seller Central | Playwright |

## 项目结构 (7 个核心文件)

```
amz卖家每日消息推送/
├── src/
│   ├── collectors/
│   │   ├── wearesellers.ts   # 知无不言 Playwright 爬虫 (P0)
│   │   ├── rss.ts            # AMZ123 RSS 采集
│   │   ├── reddit.ts         # Reddit JSON 采集
│   │   └── sellercentral.ts  # Seller Central Playwright 爬虫 (P2)
│   ├── config.ts             # 集中配置常量
│   ├── utils.ts              # 共享工具函数 (SSRF 防护, sleep)
│   ├── process.ts            # Gemini AI 处理管道
│   ├── store.ts              # Supabase 读写
│   ├── email.ts              # Gmail SMTP 邮件生成+发送
│   └── main.ts               # 入口编排 (10分钟超时保护)
├── templates/
│   └── email.html            # 邮件 HTML 模板
├── .github/workflows/
│   └── daily-digest.yml      # GitHub Actions cron
├── .env.example
├── package.json
├── tsconfig.json
├── PLAN.md                   # 本文件
└── README.md
```

## 数据库 (Supabase, 2 张表)

```sql
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  url TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  summary TEXT,
  category TEXT,
  score REAL DEFAULT 0,
  keywords TEXT[],
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE UNIQUE NOT NULL,
  sent_at TIMESTAMPTZ,
  article_count INT,
  email_html TEXT
);

CREATE INDEX idx_articles_created ON articles(created_at DESC);
CREATE INDEX idx_articles_url ON articles(url);
```

## AI 处理 (Gemini Flash)

单次批量调用处理一批文章:
- 相关性打分 (1-10)
- 中文摘要 (50-80字)
- 分类: policy/experience/trend/other
- 3个关键词
- 低于 6 分丢弃，URL 去重

## 实施步骤 (每步 ≤3 文件)

### 1.1 项目脚手架 ✅
- `package.json` — tsx, playwright, @supabase/supabase-js, nodemailer, @google/genai
- `tsconfig.json` — strict mode
- `.env.example`

### 1.2 数据层 ✅
- `src/store.ts` — Supabase client + upsert/query

### 1.3 知无不言采集器 ✅
- `src/collectors/wearesellers.ts` — Playwright + cookie 登录

### 1.4 RSS + Reddit 采集器 ✅
- `src/collectors/rss.ts` — rss-parser + 5s timeout
- `src/collectors/reddit.ts` — typed Reddit JSON API + AbortSignal timeout

### 1.5 AI 处理 ✅
- `src/process.ts` — 并发批处理 (MAX_CONCURRENCY=3) + 指数退避重试 + 类型守卫

### 1.6 邮件 ✅
- `src/email.ts` — HTML escaping + template caching + alert email
- `templates/email.html` — 响应式 + 内联 CSS + 深蓝/橙色配色

### 1.7 串联 + CI ✅
- `src/main.ts` — 5 步管道 + 并行采集 + cookie 过期告警
- `.github/workflows/daily-digest.yml` — 每日 06:00 UTC cron

## 技术栈

```
运行时: Node.js 20 + tsx
爬虫: playwright
数据库: @supabase/supabase-js
AI: @google/genai (Gemini 3 Flash Preview)
邮件: nodemailer (Gmail SMTP)
RSS: rss-parser
环境变量: dotenv
```

## 环境变量

```
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
GMAIL_USER=
GMAIL_APP_PASSWORD=
DIGEST_EMAIL=
WEARESELLERS_COOKIES=
```

## GitHub Actions Secrets (部署时配置)

上述所有环境变量 + WEARESELLERS_COOKIES (加密的 cookie JSON)

## 验证步骤

1. 本地 `npx tsx src/main.ts` 完整跑一次
2. 检查 Supabase 有知无不言文章数据
3. 检查邮箱收到摘要
4. Push GitHub → 手动 workflow_dispatch
5. 等一天确认 cron 自动执行

## Go-Live 收尾清单（明天不翻车）

- [ ] GitHub Actions `Daily Digest` workflow 状态为 `active`
- [ ] Secrets 已配置且非空：
  - `GEMINI_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_KEY`
  - `GMAIL_USER`
  - `GMAIL_APP_PASSWORD`
  - `DIGEST_EMAIL`
  - `WEARESELLERS_COOKIES`
- [ ] `.github/workflows/daily-digest.yml` 已包含 4 个时段：
  - `06:00 / 06:10 / 06:20 / 06:35 UTC`
- [ ] digest job 包含发送后静默复核：
  - `Verify digest quality floor after run (silent)`
- [ ] watchdog job 包含低量阈值检查（`article_count >= 30`）
- [ ] 今天的 Daily Digest 运行链路已出现：
  - 至少 1 次 `digest=success`
  - 06:35 的 `watchdog=success`
- [ ] 邮箱能在收件箱/垃圾箱搜索到主题：
  - `AMZ Daily Digest — YYYY-MM-DD`

回滚与应急：
- 若明天 06:35 UTC 后仍无合格 digest，先手动触发 `workflow_dispatch(confirm=yes)`；
- 同时检查 Supabase 迁移是否完整（`digest_runs/subscribers/digest_deliveries`）。

## V2 扩展路线

- Web 面板 (Next.js on Vercel)
- X (Twitter) — 找到免费方案后
- 更多中文源 (创蓝、卖家精灵、亿恩网)
- 人工筛选交互
- 话题聚合
- 智能关注
