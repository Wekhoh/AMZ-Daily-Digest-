/**
 * Health check script — validates environment and connectivity.
 * Run with: npm run health
 *
 * Checks:
 * 1. All required env vars are set
 * 2. Supabase connection works
 * 3. Gmail SMTP transporter verifies
 * 4. DeepSeek API key is valid (lightweight test)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';
import { DEEPSEEK_THINKING_DISABLED, type DeepSeekChatParams } from './config.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface ChatChoiceLike {
  message?: { content?: string | null } | null;
  finish_reason?: string | null;
}

interface ChatCompletionLike {
  choices?: ChatChoiceLike[] | null;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}: ${detail}`);
}

export function evaluateChatCompletionResponse(response: ChatCompletionLike): {
  ok: boolean;
  detail: string;
} {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const rawText = choices[0]?.message?.content;
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (text.length > 0) {
    return { ok: true, detail: `Response: "${text.slice(0, 20)}"` };
  }

  if (choices.length > 0) {
    const finishReasons = [
      ...new Set(
        choices
          .map((choice) => choice.finish_reason?.trim())
          .filter((value): value is string => Boolean(value))
      ),
    ];
    const reasonText = finishReasons.length > 0 ? finishReasons.join(', ') : 'UNKNOWN';
    return {
      ok: true,
      detail: `No text, but ${choices.length} choice(s) returned (finish: ${reasonText})`,
    };
  }

  return { ok: false, detail: 'Empty response' };
}

// ---------------------------------------------------------------------------
// Check 1: Environment variables
// ---------------------------------------------------------------------------
function checkEnvVars(): void {
  const required = [
    'DEEPSEEK_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'DIGEST_EMAIL',
    'WEARESELLERS_COOKIES',
  ];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length === 0) {
    record('Env Vars', true, `All ${required.length} required vars set`);
  } else {
    record('Env Vars', false, `Missing: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: Supabase connectivity
// ---------------------------------------------------------------------------
async function checkSupabase(): Promise<void> {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) {
      record('Supabase', false, 'Missing SUPABASE_URL or SUPABASE_KEY');
      return;
    }

    const db = createClient(url, key);
    const { error } = await db.from('digests').select('date').limit(1);

    if (error) {
      record('Supabase', false, `Query failed: ${error.message}`);
    } else {
      record('Supabase', true, 'Connected, digests table accessible');
    }
  } catch (err) {
    record('Supabase', false, `Connection error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: Gmail SMTP
// ---------------------------------------------------------------------------
async function checkGmail(): Promise<void> {
  try {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      record('Gmail SMTP', false, 'Missing GMAIL_USER or GMAIL_APP_PASSWORD');
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: { user, pass },
    });

    await transporter.verify();
    record('Gmail SMTP', true, 'Transporter verified, auth OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record('Gmail SMTP', false, `Verify failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: DeepSeek API
// ---------------------------------------------------------------------------
async function checkDeepSeek(): Promise<void> {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      record('DeepSeek API', false, 'Missing DEEPSEEK_API_KEY');
      return;
    }

    const client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
    const body: DeepSeekChatParams = {
      model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Reply with only the word "OK".' }],
      max_tokens: 64,
      thinking: DEEPSEEK_THINKING_DISABLED,
    };

    const response = await client.chat.completions.create(body);

    const evaluation = evaluateChatCompletionResponse(response);
    record('DeepSeek API', evaluation.ok, evaluation.detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record('DeepSeek API', false, `API error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('\n=== AMZ Daily Digest — Health Check ===\n');

  checkEnvVars();
  await checkSupabase();
  await checkGmail();
  await checkDeepSeek();

  console.log('\n--- Summary ---');
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`${passed}/${total} checks passed\n`);

  if (passed < total) {
    process.exit(1);
  }
}

if (process.env.AMZ_SKIP_HEALTH_AUTORUN !== '1') {
  main().catch((err) => {
    console.error('Health check crashed:', err);
    process.exit(1);
  });
}
