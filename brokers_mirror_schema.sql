-- Copy of the brokers-dashboard sb_* tables (abiyani-tools/brokersdashboard, Supabase project
-- everjfpbnlbcpuarnhob), filled on weekdays by scripts/brokers_mirror.py (.github/workflows/brokers-mirror.yml).
-- Definitions: the brokers team's catalog, sucaanalytics-max/ExchangesDash#36, 3 Nov 2026. Their schema
-- endpoint does not serve the publishable key, so --emit-ddl cannot generate this file.
-- sb_pat_lines (the PAT model's output) is from their migrations/20261105_sb_pat_lines.sql, applied there on
-- 6 Nov 2026 and here on 7 Nov; sb_valuation_lines (the valuation's output) is from their
-- migrations/20261109_sb_valuation_lines.sql (definition posted on #75), applied there on 9 Nov and here on 10 Nov.
-- Add a new table here only after it exists on their side: the mirror copies
-- every sb_* table that exists here, and one their side does not have yet fails each run (HTTP 404 from their API).
-- Same names, columns, types, NOT NULL, defaults and primary keys. Their foreign keys and CHECK constraints
-- are left out: the mirror loads tables in name order, and the source already enforces both.
-- RLS is on with no policies: only the service role reads or writes these tables.
-- Not mirrored (anon cannot read them on their side): sb_assumptions, sb_disclosure_facts, sb_documents,
-- sb_market_daily, sb_market_monthly, sb_parity_expected, sb_parity_pins; views sb_facts_current, sb_fact_conflicts.

create table if not exists public.sb_brokers (
  broker_id text not null,
  name text not null,
  nse_symbol text,
  bse_code text,
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  primary key (broker_id)
);
alter table public.sb_brokers enable row level security;
comment on table public.sb_brokers is 'Copy of brokers-dashboard sb_brokers (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_runs (
  run_id uuid not null default gen_random_uuid(),
  broker_id text not null,
  mode text not null,
  as_of_date date,
  started_at timestamp with time zone not null default now(),
  finished_at timestamp with time zone,
  status text not null default 'running',
  parity_pass boolean,
  code_version text,
  notes text,
  primary key (run_id)
);
alter table public.sb_runs enable row level security;
comment on table public.sb_runs is 'Copy of brokers-dashboard sb_runs (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_summary_cells (
  run_id uuid not null,
  broker_id text not null,
  panel text not null,
  table_name text not null,
  row_label text not null,
  value numeric,
  comparison text,
  comp_value numeric,
  period_type text not null,
  period_key text not null,
  note text,
  primary key (run_id, panel, period_type, period_key, table_name, row_label)
);
alter table public.sb_summary_cells enable row level security;
comment on table public.sb_summary_cells is 'Copy of brokers-dashboard sb_summary_cells (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_daily_revenue (
  run_id uuid not null,
  broker_id text not null,
  trade_date date not null,
  segment text not null,
  orders_mn numeric,
  revenue_cr numeric,
  regime text not null,
  primary key (run_id, trade_date, segment)
);
alter table public.sb_daily_revenue enable row level security;
comment on table public.sb_daily_revenue is 'Copy of brokers-dashboard sb_daily_revenue (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_calibration (
  run_id uuid not null,
  broker_id text not null,
  segment text not null,
  period_type text not null,
  period_key text not null,
  param text not null,
  value numeric,
  regime text not null,
  rule text,
  source_periods text,
  primary key (run_id, segment, period_key, param)
);
alter table public.sb_calibration enable row level security;
comment on table public.sb_calibration is 'Copy of brokers-dashboard sb_calibration (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_calendar (
  trade_date date not null,
  fy text not null,
  q_fy text not null,
  fy_month text not null,
  weekday text not null,
  is_equity_day boolean not null default false,
  is_mcx_day boolean not null default false,
  special_session text,
  note text,
  primary key (trade_date)
);
alter table public.sb_calendar enable row level security;
comment on table public.sb_calendar is 'Copy of brokers-dashboard sb_calendar (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_broker_daily (
  broker_id text not null,
  fetched_at timestamp with time zone not null,
  snapshot_date date not null,
  metric text not null,
  period_key text not null,
  value numeric not null,
  unit text not null,
  is_qtd boolean not null,
  source text not null,
  source_ref text not null,
  covers_through date,
  primary key (broker_id, snapshot_date, metric, period_key)
);
alter table public.sb_broker_daily enable row level security;
comment on table public.sb_broker_daily is 'Copy of brokers-dashboard sb_broker_daily (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_share_prices (
  broker_id text not null,
  trade_date date not null,
  ticker text not null,
  close numeric not null,
  adj_close numeric,
  source text not null,
  source_ref text not null,
  fetched_at timestamp with time zone not null,
  primary key (broker_id, trade_date)
);
alter table public.sb_share_prices enable row level security;
comment on table public.sb_share_prices is 'Copy of brokers-dashboard sb_share_prices (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_pat_lines (
  run_id uuid not null,
  broker_id text not null,
  period_key text not null,
  line text not null,
  scenario text not null default '',
  label text not null,
  value numeric not null,
  unit text not null,
  regime text not null,
  rule text,
  sort_order integer not null,
  primary key (run_id, period_key, line, scenario)
);
alter table public.sb_pat_lines enable row level security;
comment on table public.sb_pat_lines is 'Copy of brokers-dashboard sb_pat_lines (scripts/brokers_mirror.py); not edited by hand.';

create table if not exists public.sb_valuation_lines (
  run_id uuid not null,
  broker_id text not null,
  section text not null,
  period_key text not null default '',
  line text not null,
  scenario text not null default '',
  label text not null,
  value numeric not null,
  unit text not null,
  rule text,
  sort_order integer not null,
  primary key (run_id, section, period_key, line, scenario)
);
alter table public.sb_valuation_lines enable row level security;
comment on table public.sb_valuation_lines is 'Copy of brokers-dashboard sb_valuation_lines (scripts/brokers_mirror.py); not edited by hand.';
