-- Read-only fingerprints for a restored Agent Studio database. Run with psql -At -f -
-- against the stopped source and the restored copy before converting either row.
SELECT 'items', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM items t
UNION ALL
SELECT 'runtime_sessions', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM runtime_sessions t
UNION ALL
SELECT 'users', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM "user" t
UNION ALL
SELECT 'auth_sessions', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM "session" t
UNION ALL
SELECT 'accounts', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM "account" t
UNION ALL
SELECT 'verifications', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM "verification" t
UNION ALL
SELECT 'vectors', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM catalog_vectors t
UNION ALL
SELECT 'migrations', count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) FROM schema_migrations t
ORDER BY 1;
