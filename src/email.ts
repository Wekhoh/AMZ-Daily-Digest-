import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import type { Article } from './store.js';
import { EMAIL } from './config.js';

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, string> = {
  policy: '📋 政策动态',
  experience: '💡 运营经验',
  trend: '📈 行业趋势',
  other: '📌 其他',
};

const CATEGORY_ORDER = ['policy', 'experience', 'trend', 'other'] as const;

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (cachedTemplate) return cachedTemplate;

  const templatePath = new URL('../templates/email.html', import.meta.url);
  cachedTemplate = readFileSync(templatePath, 'utf-8');
  return cachedTemplate;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Only allow http/https URLs — blocks javascript:, data:, file:, etc. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return url;
    }
    return '#';
  } catch {
    return '#';
  }
}

function buildArticleHtml(article: Article): string {
  const title = escapeHtml(article.title);
  const summary = article.summary ? escapeHtml(article.summary) : '';
  const source = escapeHtml(article.source);
  const url = escapeHtml(sanitizeUrl(article.url));

  const keywords = (article.keywords ?? [])
    .map(
      (kw) =>
        `<span style="display:inline-block;background-color:#edf2f7;color:#4a5568;font-size:11px;padding:2px 8px;border-radius:10px;margin-right:4px;margin-bottom:4px;">${escapeHtml(kw)}</span>`
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
      <tr>
        <td style="padding:14px 16px;background-color:#f7fafc;border-radius:8px;border-left:3px solid #dd6b20;">
          <a href="${url}" style="font-size:15px;font-weight:600;color:#1a365d;text-decoration:none;line-height:1.5;" target="_blank">
            ${title}
          </a>
          ${summary ? `<p style="margin:8px 0 0 0;font-size:13px;color:#4a5568;line-height:1.6;">${summary}</p>` : ''}
          <p style="margin:8px 0 0 0;font-size:12px;color:#a0aec0;">
            来源: ${source}
            ${keywords ? `<span style="margin-left:8px;">${keywords}</span>` : ''}
          </p>
        </td>
      </tr>
    </table>`;
}

function buildCategoryHtml(
  label: string,
  articles: Article[]
): string {
  const articlesHtml = articles.map(buildArticleHtml).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding-bottom:12px;">
          <h2 style="margin:0;font-size:18px;font-weight:700;color:#1a365d;border-bottom:2px solid #dd6b20;padding-bottom:8px;display:inline-block;">
            ${escapeHtml(label)}
          </h2>
        </td>
      </tr>
      <tr>
        <td>${articlesHtml}</td>
      </tr>
    </table>`;
}

// ---------------------------------------------------------------------------
// Public: generate email HTML
// ---------------------------------------------------------------------------

export function generateEmailHtml(articles: Article[], date: string): string {
  console.log(`[Email] Generating email HTML for ${articles.length} articles on ${date}`);

  const template = loadTemplate();

  // Group articles by category
  const groups = new Map<string, Article[]>();
  for (const article of articles) {
    const key = article.category ?? 'other';
    const normalised = CATEGORY_MAP[key] ? key : 'other';
    const list = groups.get(normalised) ?? [];
    list.push(article);
    groups.set(normalised, list);
  }

  // Build categories HTML in defined order
  const categoriesHtml = CATEGORY_ORDER.filter((key) => groups.has(key))
    .map((key) => {
      const label = CATEGORY_MAP[key] ?? CATEGORY_MAP['other'];
      return buildCategoryHtml(label, groups.get(key)!);
    })
    .join('');

  const html = template
    .replace(/\{\{date\}\}/g, escapeHtml(date))
    .replace(/\{\{count\}\}/g, String(articles.length))
    .replace(/\{\{categories_html\}\}/g, categoriesHtml);

  console.log(`[Email] HTML generated successfully (${html.length} bytes)`);
  return html;
}

// ---------------------------------------------------------------------------
// Public: send digest email
// ---------------------------------------------------------------------------

let cachedTransporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (cachedTransporter) return cachedTransporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD environment variable');
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: { user, pass },
  });
  return cachedTransporter;
}

async function sendMailWithRetry(
  options: Parameters<nodemailer.Transporter['sendMail']>[0]
): Promise<{ messageId: string }> {
  for (let attempt = 0; attempt <= EMAIL.MAX_RETRIES; attempt++) {
    try {
      return await getTransporter().sendMail(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Email] Send attempt ${attempt + 1} failed: ${msg}`);

      if (attempt < EMAIL.MAX_RETRIES) {
        console.log(`[Email] Retrying in ${EMAIL.RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, EMAIL.RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

export async function sendDigestEmail(
  html: string,
  date: string,
  recipients?: string[],
): Promise<{
  sent: Array<{ email: string; messageId: string }>;
  failed: Array<{ email: string; error: string }>;
}> {
  const envRecipient = process.env.DIGEST_EMAIL;
  const recipientList = (recipients ?? (envRecipient ? [envRecipient] : []))
    .map((r) => r.trim())
    .filter(Boolean);
  const uniqueRecipients = [...new Set(recipientList)];

  if (uniqueRecipients.length === 0) {
    throw new Error('No digest recipients configured');
  }

  const from = `AMZ Daily Digest <${process.env.GMAIL_USER}>`;
  const subject = `AMZ Daily Digest — ${date}`;
  const sent: Array<{ email: string; messageId: string }> = [];
  const failed: Array<{ email: string; error: string }> = [];

  console.log(
    `[Email] Sending digest email to ${uniqueRecipients.length} recipient(s) — "${subject}"`
  );

  for (const to of uniqueRecipients) {
    const maskedTo = to.replace(/(.{2}).*(@.*)/, '$1***$2');
    try {
      const info = await sendMailWithRetry({ from, to, subject, html });
      sent.push({ email: to, messageId: info.messageId });
      console.log(`[Email] Digest email sent to ${maskedTo} (id: ${info.messageId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ email: to, error: message });
      console.warn(`[Email] Failed to send digest to ${maskedTo}: ${message}`);
    }
  }

  if (sent.length === 0) {
    throw new Error(`Digest email failed for all recipients (${failed.length} failed)`);
  }

  console.log(
    `[Email] Digest send summary: ${sent.length} sent, ${failed.length} failed`
  );

  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Public: send alert email
// ---------------------------------------------------------------------------

export async function sendAlertEmail(message: string): Promise<void> {
  const to = process.env.DIGEST_EMAIL;
  if (!to) {
    throw new Error('Missing DIGEST_EMAIL environment variable');
  }

  const from = `AMZ Daily Digest <${process.env.GMAIL_USER}>`;

  const maskedAlert = to.replace(/(.{2}).*(@.*)/, '$1***$2');
  console.log(`[Email] Sending alert email to ${maskedAlert}`);

  const alertHtml = `
    <div style="font-family:Arial,sans-serif;padding:24px;max-width:560px;margin:0 auto;">
      <h2 style="color:#c53030;margin:0 0 16px 0;">AMZ Daily Digest 告警</h2>
      <div style="background-color:#fff5f5;border:1px solid #feb2b2;border-radius:8px;padding:16px;">
        <p style="margin:0;color:#742a2a;font-size:14px;line-height:1.6;">${escapeHtml(message)}</p>
      </div>
      <p style="margin:16px 0 0 0;font-size:12px;color:#a0aec0;">自动生成 by AMZ Daily Digest</p>
    </div>`;

  const info = await sendMailWithRetry({
    from,
    to,
    subject: 'AMZ Daily Digest — 系统告警',
    html: alertHtml,
  });

  console.log(`[Email] Alert email sent successfully (id: ${info.messageId})`);
}
