package voting

import (
	"context"
	"os"
	"testing"

	dbmigrations "github.com/digital-democracy/api-go/db"
	"github.com/digital-democracy/api-go/internal/pg"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testDatabaseURL returns the Postgres URL for backend tests, or "" to skip.
func testDatabaseURL() string { return os.Getenv("TEST_DATABASE_URL") }

// ensureMigrated runs the app's own migration runner (internal/pg) against
// the test database. It is idempotent (schema_migrations), so every
// package's suite can call it — which also proves reruns are safe.
func ensureMigrated(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := pg.Up(context.Background(), pool, dbmigrations.Files); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}
