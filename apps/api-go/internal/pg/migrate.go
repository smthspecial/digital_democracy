package pg

import (
	"context"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
)

// orderedVersions lists migrations in apply order. Later schema changes get
// their own numbered pair under db/migrations plus an entry here
// (ARCH-023 §1).
var orderedVersions = []string{"0001_init"}

// migrateAdvisoryLock serializes concurrent Up runners (parallel test
// binaries, rolled deploys) so two processes never CREATE the same objects
// at once. Session-level: held until conn release at the end of Up.
const migrateAdvisoryLock = 42036000

// Up applies pending migrations from files (the embedded db.Files in
// production), tracked in schema_migrations. Files run over the simple
// protocol (PgConn.Exec) so multi-statement migrations with plpgsql bodies
// execute as written — pgx's extended-protocol Exec cannot carry more than
// one statement.
func Up(ctx context.Context, pool *pgxpool.Pool, files fs.FS) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("pg: acquire for migrate: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrateAdvisoryLock); err != nil {
		return fmt.Errorf("pg: migrate lock: %w", err)
	}

	execFile := func(name, sql string) error {
		if _, err := conn.Conn().PgConn().Exec(ctx, sql).ReadAll(); err != nil {
			return fmt.Errorf("pg: migrate %s: %w", name, err)
		}
		return nil
	}

	if err := execFile("schema_migrations", `CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}

	applied := map[string]bool{}
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("pg: read schema_migrations: %w", err)
	}
	var v string
	for rows.Next() {
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("pg: scan schema_migrations: %w", err)
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("pg: read schema_migrations: %w", err)
	}

	for _, version := range orderedVersions {
		if applied[version] {
			continue
		}
		raw, err := fs.ReadFile(files, "migrations/"+version+".up.sql")
		if err != nil {
			return fmt.Errorf("pg: read migration %s: %w", version, err)
		}
		if err := execFile(version, string(raw)); err != nil {
			return err
		}
		if _, err := conn.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			return fmt.Errorf("pg: record migration %s: %w", version, err)
		}
	}
	return nil
}
