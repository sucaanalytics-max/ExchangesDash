-- ============================================================================
-- Cutover: tag which pipeline wrote each daily row, and add the NSE columns
-- this repo's pipeline writes
-- ============================================================================
-- Run once in the ExchangesDash Supabase project's SQL editor at cutover,
-- BEFORE setting the repository variables ENABLE_SUPABASE_WRITES or
-- PIPELINE_SOURCE (e.g. exchangesdash): the NSE/BSE pipelines then upsert
-- rows carrying these columns, and an upsert fails if a column does not exist.
-- Rows written before (by Research-Tusk/nse-cloud-pipeline) keep NULL, so
--   select pipeline_source, count(*) from nse_daily group by 1;
-- shows who wrote what. The run logs (nse_pipeline_runs / bse_pipeline_runs)
-- carry the same value in their existing `source` column.
-- Safe to run more than once.
-- ============================================================================

alter table public.nse_daily add column if not exists pipeline_source text;
alter table public.bse_daily add column if not exists pipeline_source text;

-- NSE activity detail (no revenue figure uses them; NULL = not published).
-- Same names and units as bse_daily's cash columns; cash_quantity is shares
-- (NSE publishes lakh shares). The per-segment contracts already exist in the
-- live table; listed so a fresh project gets them too.
alter table public.nse_daily add column if not exists cash_trades     bigint;
alter table public.nse_daily add column if not exists cash_securities integer;
alter table public.nse_daily add column if not exists cash_quantity   bigint;
alter table public.nse_daily add column if not exists if_contracts    bigint;
alter table public.nse_daily add column if not exists sf_contracts    bigint;
alter table public.nse_daily add column if not exists io_contracts    bigint;
alter table public.nse_daily add column if not exists so_contracts    bigint;
