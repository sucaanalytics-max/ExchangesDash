-- Read-only Postgres login for analysts (analyst/README.md): `vatsal_ro` on
-- both Supabase projects. A record of what is applied, not run by any job.
--
-- History
--   NSE-BSE (vuswwmczfrlzjoxfvkzu)
--     2026-11-18 create_vatsal_readonly_role: role created (bypassrls, noinherit,
--                connection limit 5, read-only, 120 s timeout), public / mtf /
--                argus granted; password set then by the owner.
--     2026-11-25 analyst_readonly_role: idle-in-transaction timeout; stale NSE/BSE
--                tables revoked (below).
--     2026-11-25 analyst_readonly_role_drop_mtf: mtf schema revoked.
--     2026-11-25 analyst_readonly_role_regrant_nse_bse: nse_daily, bse_daily,
--                nse_aggregates, bse_aggregates granted again after the
--                Supabase cutover (supabase_cutover.sql run, rows 28 Oct-23 Nov
--                backfilled from the repo JSON, ENABLE_SUPABASE_WRITES on).
--   OctoTusk + MCX (avqwpebveqetwwzkmtux)
--     2026-11-25 analyst_readonly_role: role created; password still to be set.
--
-- Passwords are never committed. The project owner sets them in the SQL editor
-- (`alter role vatsal_ro password '…';`). Connect through each project's
-- session pooler as `vatsal_ro.<project ref>`.
--
-- Every table in both projects has RLS on, with policies only for the app
-- roles. A plain role would read 0 rows and see what looks like an empty table,
-- so this role bypasses RLS instead. It still can't write: it has SELECT grants
-- only and read-only transactions. Its time and connection limits stop it from
-- starving the pipelines. On 25 Nov every granted table's count(*) matched the
-- owner's: 75 tables on NSE-BSE, 63 on OctoTusk + MCX.

-- ── Both projects ─────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'vatsal_ro') then
    create role vatsal_ro login bypassrls noinherit connection limit 5;
  end if;
end $$;
alter role vatsal_ro bypassrls connection limit 5;
alter role vatsal_ro set default_transaction_read_only = on;
alter role vatsal_ro set statement_timeout = '120s';
alter role vatsal_ro set idle_in_transaction_session_timeout = '300s';

-- ── NSE-BSE project (vuswwmczfrlzjoxfvkzu) ────────────────────────────────
-- Granted: public (sb_* brokers mirror, broker research library rl_* /
-- broker_*, codex_*, nse_pnl …) and argus.
-- Not granted:
--   private, migration_backup: PIN config / sessions and one-off backups.
--   mtf: a one-off Sep 2026 load (mtf.trading's files, a source the broker
--        register does not accept) and exchange_daily, last written 23 Sep;
--        the repo's mtf_*.json are current.
--   (nse_daily, bse_daily, nse_aggregates and bse_aggregates were revoked
--   while stale and granted again on 25 Nov 2026, once they matched the repo.)
--   mtf stays revoked: ENABLE_MTF_WRITES is off, so nothing keeps it current.
grant usage on schema public, argus to vatsal_ro;
grant select on all tables in schema public, argus to vatsal_ro;
alter default privileges for role postgres in schema public, argus grant select on tables to vatsal_ro;
revoke select on all tables in schema mtf from vatsal_ro;
alter default privileges for role postgres in schema mtf revoke select on tables from vatsal_ro;
revoke usage on schema mtf from vatsal_ro;

-- ── OctoTusk + MCX project (avqwpebveqetwwzkmtux) ─────────────────────────
-- Granted: public (mcx_commodity_daily, mcx_daily_revenue, margins, OI
-- participants, prices, app tables …).
-- Not granted: push_subscriptions (web-push keys), pin_attempts, user_roles.
-- grant usage on schema public to vatsal_ro;
-- grant select on all tables in schema public to vatsal_ro;
-- alter default privileges for role postgres in schema public grant select on tables to vatsal_ro;
-- revoke select on public.push_subscriptions, public.pin_attempts, public.user_roles from vatsal_ro;
