-- ============================================================================
-- valuation_inputs: the Valuation Model's shared inputs, and their Excel sync
-- ============================================================================
-- The inputs drawer on the Valuation Model tab used to save edits in each
-- viewer's browser only. These tables hold them once, for everyone:
--
--   valuation_inputs      one row per exchange: the sparse overrides of
--                         dashboard/data/valuation_inputs.json, the same shape the
--                         browser kept, e.g. {"pe1": 48, "adr": null}
--   valuation_inputs_log  every change, before and after, for audit: written by
--                         the trigger below in the same transaction as the change
--   excel_sync_runs       runs of the Excel mirror (scheduled or from the
--                         dashboard's Refresh Excel button); created now, used
--                         from the Excel mirror PR on
--
-- Writer: dashboard/api/valuation-inputs.js (Vercel), with the service-role key
-- (SUPABASE_URL, SUPABASE_SERVICE_KEY); PUT only for a team member signed in with
-- the shared password (/api/team-login). Its GET serves the inputs to everyone,
-- so the tables need no public access: RLS is on with no policies and the
-- public roles hold no privileges, leaving the service role (which bypasses RLS)
-- as the only reader and writer. updated_by / changed_by are a short hash of the
-- writer's IP: a shared password has no user identities.
--
-- Run once in the Supabase SQL editor (project used by ExchangesDash), then set
-- the Vercel env vars above. CLAUDE.md's data-flow table lists it.
-- ============================================================================

begin;

create table if not exists public.valuation_inputs (
  exchange   text        primary key check (exchange in ('bse', 'mcx', 'nse')),
  inputs     jsonb       not null default '{}'::jsonb,   -- sparse overrides, {"pe1": 48, "adr": null}
  updated_at timestamptz not null default now(),
  updated_by text                                         -- IP hash (12 hex)
);

comment on table public.valuation_inputs is
  'Shared Valuation Model inputs per exchange: overrides of dashboard/data/valuation_inputs.json, written by /api/valuation-inputs.';

create table if not exists public.valuation_inputs_log (
  id         bigserial   primary key,
  exchange   text        not null check (exchange in ('bse', 'mcx', 'nse')),
  before     jsonb,
  after      jsonb,
  changed_at timestamptz not null default now(),
  changed_by text                                         -- IP hash (12 hex)
);

comment on table public.valuation_inputs_log is
  'Audit trail of valuation_inputs: one row per change, the overrides before and after.';

create index if not exists valuation_inputs_log_latest
  on public.valuation_inputs_log (exchange, changed_at desc);

create table if not exists public.excel_sync_runs (
  id            bigserial   primary key,
  trigger       text        not null check (trigger in ('scheduled', 'manual')),
  status        text        not null default 'queued'
                            check (status in ('queued', 'running', 'success', 'partial', 'failed')),
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  files         jsonb,                                    -- per-file results
  error         text,
  github_run_id bigint
);

-- One manual run queued at a time: two presses of Refresh Excel at the same moment
-- cannot both insert one (the second insert answers 409, and
-- dashboard/api/excel-refresh.js returns the first run). A run already running does not
-- count: it read the inputs when it started, so a press then queues a new one. Other
-- rows (scheduled, or dispatched by hand from GitHub, which insert their own running
-- row) are not limited: the workflow's concurrency group runs one job at a time.
-- Every queued manual row but the newest is closed first, so the index can always be
-- built: under the old rule two could be queued within the same 45 minutes. The newest
-- stays queued (its run may still start); if it is stale, /api/excel-refresh closes it.
-- Safe to run again.
update public.excel_sync_runs
   set status = 'failed', finished_at = now(),
       error = 'never finished: closed before the one-queued-run index was added'
 where trigger = 'manual' and status = 'queued'
   and id <> (select max(id) from public.excel_sync_runs where trigger = 'manual' and status = 'queued');

create unique index if not exists excel_sync_runs_one_manual
  on public.excel_sync_runs ((true))
  where trigger = 'manual' and status = 'queued';

comment on table public.excel_sync_runs is
  'Runs of the Excel mirror (inputs and results into the workbooks): trigger, status and per-file results.';

create index if not exists excel_sync_runs_latest
  on public.excel_sync_runs (requested_at desc);

-- The audit log, atomic with the change: one row per insert or update that changes
-- the inputs (an insert's "before" is {}); changed_by is the writer's updated_by.
create or replace function public.valuation_inputs_log_change()
returns trigger language plpgsql set search_path = public as $$
declare
  prev jsonb := case when tg_op = 'UPDATE' then old.inputs else '{}'::jsonb end;
begin
  if new.inputs is not distinct from prev then
    return new;
  end if;
  insert into public.valuation_inputs_log (exchange, before, after, changed_by)
  values (new.exchange, prev, new.inputs, new.updated_by);
  return new;
end;
$$;

drop trigger if exists valuation_inputs_log_change on public.valuation_inputs;
create trigger valuation_inputs_log_change
  after insert or update on public.valuation_inputs
  for each row execute function public.valuation_inputs_log_change();

-- Service role only: RLS on with no policies, nothing granted to the public roles
alter table public.valuation_inputs     enable row level security;
alter table public.valuation_inputs_log enable row level security;
alter table public.excel_sync_runs      enable row level security;
revoke all on public.valuation_inputs, public.valuation_inputs_log, public.excel_sync_runs from anon, authenticated;
revoke all on sequence public.valuation_inputs_log_id_seq, public.excel_sync_runs_id_seq from anon, authenticated;
revoke all on function public.valuation_inputs_log_change() from public, anon, authenticated;

commit;

-- Checks
--   select exchange, inputs, updated_at from public.valuation_inputs order by exchange;
--   select * from public.valuation_inputs_log order by changed_at desc limit 20;
--   select * from public.excel_sync_runs order by requested_at desc limit 10;
