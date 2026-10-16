-- Auth maintenance uses the restricted worker role, never the migration owner.
GRANT DELETE ON session TO api_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_worker;
