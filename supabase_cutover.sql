-- ============================================================================
-- Cutover: tag which pipeline wrote each daily row
-- ============================================================================
-- Run once in the ExchangesDash Supabase project's SQL editor at cutover,
-- BEFORE setting the repository variable PIPELINE_SOURCE (e.g. exchangesdash):
-- with the variable set, the NSE/BSE pipelines add pipeline_source to every
-- row they upsert, and the upsert fails if the column does not exist.
-- Rows written before (by Research-Tusk/nse-cloud-pipeline) keep NULL, so
--   select pipeline_source, count(*) from nse_daily group by 1;
-- shows who wrote what. The run logs (nse_pipeline_runs / bse_pipeline_runs)
-- carry the same value in their existing `source` column.
-- Safe to run more than once.
-- ============================================================================

alter table public.nse_daily add column if not exists pipeline_source text;
alter table public.bse_daily add column if not exists pipeline_source text;
