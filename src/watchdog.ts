import 'dotenv/config';
import { sendAlertEmail } from './email.js';
import { getDigestByDate } from './store.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isAlertEnabled(flag = process.env.AMZ_WATCHDOG_ALERT_ON_MISSING): boolean {
  if (!flag) return true;
  const normalized = flag.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

export function resolveWatchdogDate(
  now = new Date(),
  override = process.env.AMZ_WATCHDOG_DATE,
): string {
  if (!override) {
    return now.toISOString().slice(0, 10);
  }

  if (!DATE_REGEX.test(override)) {
    throw new Error(`Invalid AMZ_WATCHDOG_DATE format: ${override}`);
  }

  return override;
}

export async function runWatchdog(now = new Date()): Promise<void> {
  const date = resolveWatchdogDate(now);
  console.log(`[Watchdog] Verifying digest for ${date}...`);

  const digest = await getDigestByDate(date);
  if (digest) {
    console.log(
      `[Watchdog] OK: digest exists for ${date} (${digest.article_count} articles, sent_at: ${digest.sent_at ?? 'N/A'})`,
    );
    return;
  }

  const message =
    `Watchdog detected missing digest for ${date} at ${now.toISOString()}. ` +
    'No daily digest record found in Supabase.';
  console.error(`[Watchdog] ${message}`);

  if (isAlertEnabled()) {
    try {
      await sendAlertEmail(message);
      console.log('[Watchdog] Alert email sent.');
    } catch (alertErr) {
      console.error('[Watchdog] Failed to send alert email:', alertErr);
    }
  }

  throw new Error(`Digest missing for ${date}`);
}

if (process.env.AMZ_SKIP_WATCHDOG_AUTORUN !== '1') {
  runWatchdog().catch((err) => {
    console.error('[Watchdog] Fatal:', err);
    process.exit(1);
  });
}
