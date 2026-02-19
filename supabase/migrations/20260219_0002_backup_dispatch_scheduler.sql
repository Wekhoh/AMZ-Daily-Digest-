-- ----------------------------------------------------------------------------
-- AMZ Daily Digest - Backup dispatcher scheduler (Supabase Cron -> GitHub API)
--
-- Purpose:
-- 1) Keep GitHub native schedule as primary trigger
-- 2) Add independent backup trigger from Supabase pg_cron + pg_net
-- 3) Avoid duplicate emails via existing digest date idempotency in src/main.ts
--
-- Prerequisites (one-time, before executing this migration):
--   select vault.create_secret('Wekhoh', 'github_repo_owner');
--   select vault.create_secret('AMZ-Daily-Digest-', 'github_repo_name');
--   select vault.create_secret('daily-digest.yml', 'github_workflow_file');
--   select vault.create_secret('main', 'github_dispatch_ref');
--   select vault.create_secret('<GITHUB_TOKEN_WITH_ACTIONS_WRITE>', 'github_dispatch_token');
--
-- Notes:
-- - Token needs repository Actions:write permission.
-- - This migration is idempotent (safe to re-run).
-- ----------------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;
create extension if not exists vault with schema vault;

create table if not exists public.digest_dispatch_logs (
  id bigserial primary key,
  triggered_at timestamptz not null default now(),
  trigger_name text not null,
  request_id bigint not null,
  target_ref text not null default 'main'
);

comment on table public.digest_dispatch_logs is
  'Backup dispatcher logs (Supabase cron -> GitHub workflow_dispatch request_id)';

create or replace function public.dispatch_daily_digest_via_github(
  p_trigger_name text default 'supabase_cron'
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_owner text;
  v_repo text;
  v_workflow text;
  v_dispatch_ref text;
  v_dispatch_token text;
  v_url text;
  v_request_id bigint;
begin
  select decrypted_secret into v_owner
  from vault.decrypted_secrets
  where name = 'github_repo_owner'
  limit 1;

  select decrypted_secret into v_repo
  from vault.decrypted_secrets
  where name = 'github_repo_name'
  limit 1;

  select decrypted_secret into v_workflow
  from vault.decrypted_secrets
  where name = 'github_workflow_file'
  limit 1;

  select decrypted_secret into v_dispatch_ref
  from vault.decrypted_secrets
  where name = 'github_dispatch_ref'
  limit 1;

  select decrypted_secret into v_dispatch_token
  from vault.decrypted_secrets
  where name = 'github_dispatch_token'
  limit 1;

  if v_owner is null or v_repo is null or v_workflow is null
     or v_dispatch_ref is null or v_dispatch_token is null then
    raise exception 'Missing required vault secret(s) for GitHub backup dispatcher';
  end if;

  v_url := format(
    'https://api.github.com/repos/%s/%s/actions/workflows/%s/dispatches',
    v_owner,
    v_repo,
    v_workflow
  );

  v_request_id := net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || v_dispatch_token,
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'supabase-pg-net-amz-digest/1.0'
    ),
    body := jsonb_build_object(
      'ref', v_dispatch_ref,
      'inputs', jsonb_build_object('confirm', 'yes')
    )
  );

  insert into public.digest_dispatch_logs (trigger_name, request_id, target_ref)
  values (p_trigger_name, v_request_id, v_dispatch_ref);

  return v_request_id;
end;
$$;

revoke all on function public.dispatch_daily_digest_via_github(text) from public;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'amz-digest-backup-0608'
  ) then
    perform cron.unschedule('amz-digest-backup-0608');
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'amz-digest-backup-0618'
  ) then
    perform cron.unschedule('amz-digest-backup-0618');
  end if;
end $$;

-- Backup triggers (UTC): 06:08 + 06:18
-- Primary GitHub schedule remains 06:00 + 06:10 + 06:20.
-- If primary fails, backup dispatch can still trigger workflow_dispatch.
select cron.schedule(
  'amz-digest-backup-0608',
  '8 6 * * *',
  $$
  select public.dispatch_daily_digest_via_github('backup-0608');
  $$
);

select cron.schedule(
  'amz-digest-backup-0618',
  '18 6 * * *',
  $$
  select public.dispatch_daily_digest_via_github('backup-0618');
  $$
);
