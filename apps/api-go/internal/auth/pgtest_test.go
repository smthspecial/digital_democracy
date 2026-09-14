package auth

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

// ensureMigrated runs the app's own migration runner (see voting/pgtest_test.go).
func ensureMigrated(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := pg.Up(context.Background(), pool, dbmigrations.Files); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}
