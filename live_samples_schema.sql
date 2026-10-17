-- ============================================================================
-- live_samples: every intraday revenue poll, durable in Supabase
-- ============================================================================
-- Remediation plan Phase 2. Today the live pollers commit JSON to git every
-- 5 minutes; this table holds the same samples so the dashboard can later read
-- them from Supabase and the commits can stop. Nothing else writes it, so it is
-- safe to fill during the parallel run.
--
-- Writer: scripts/live_common.py store_live_sample (NSE and BSE pollers),
-- service-role key, only when the repository variable ENABLE_LIVE_SAMPLES is
-- 'true'. One row per (exchange, trade_date, elapsed_minutes): a retried poll
-- overwrites its own row. trade_date is the exchange's own date, never the
-- wall clock, and only today's session is written (pre-open, holiday and
-- prior-day readings are skipped upstream).
--
-- Run once in the Supabase SQL editor (project used by ExchangesDash), then set
-- the repository variable ENABLE_LIVE_SAMPLES = true.
-- ============================================================================

begin;

create table if not exists public.live_samples (
  exchange        text        not null check (exchange in ('nse', 'bse', 'mcx')),
  trade_date      date        not null,
  elapsed_minutes integer     not null,          -- minutes since 09:15 IST
  captured_at     timestamptz not null,
  day_type        text,                          -- expiry / pre_expiry / normal
  total_revenue   numeric(12, 4),                -- ₹ Cr, cumulative for the session
  cash_revenue    numeric(12, 4),
  options_revenue numeric(12, 4),
  futures_revenue numeric(12, 4),
  predicted_eod   numeric(12, 4),
  pred_method     text,
  raw             jsonb,                         -- the poller's revenue dict (turnover, take rates)
  inserted_at     timestamptz not null default now(),
  primary key (exchange, trade_date, elapsed_minutes)
);

comment on table public.live_samples is
  'Intraday live revenue samples from the ExchangesDash pollers (one per exchange, trade date and minute since 09:15 IST).';

create index if not exists live_samples_latest
  on public.live_samples (exchange, trade_date desc, elapsed_minutes desc);

-- Read-only for the public roles (the same figures the public live JSON shows);
-- writes need the service-role key, which bypasses RLS.
alter table public.live_samples enable row level security;
drop policy if exists "public_read_live_samples" on public.live_samples;
create policy "public_read_live_samples" on public.live_samples
  for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.live_samples from anon, authenticated;

-- Newest sample per exchange
create or replace view public.live_latest with (security_invoker = true) as
select distinct on (exchange) *
from public.live_samples
order by exchange, trade_date desc, elapsed_minutes desc;

-- One row per exchange and session: sample count, first / last minute and the
-- last cumulative revenue (the session's EOD once the last poll is past 15:00)
create or replace view public.live_days with (security_invoker = true) as
select exchange, trade_date,
       count(*)                                                    as n_samples,
       min(elapsed_minutes)                                        as first_minute,
       max(elapsed_minutes)                                        as last_minute,
       (array_agg(total_revenue order by elapsed_minutes desc))[1] as last_total_revenue,
       max(captured_at)                                            as last_captured_at
from public.live_samples
group by exchange, trade_date;

grant select on public.live_latest, public.live_days to anon, authenticated;

commit;

-- Checks
--   select * from public.live_latest;
--   select * from public.live_days order by trade_date desc limit 10;
