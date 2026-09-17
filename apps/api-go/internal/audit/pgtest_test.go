package audit

import (
	"context"
	"os"
	"testing"

	dbmigrations "github.com/digital-democracy/api-go/db"
	"github.com/digital-democracy/api-go/internal/pg"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testDatabaseURL returns the Postgres URL for backend tests. Skips when
// unset; with REQUIRE_DB_TESTS set, fails loudly instead -- mirrors
// apps/api-ts's test-support/postgres.ts so this tier can't silently skip
// with zero assertions in CI (BUG-004/TI-02) the way apps/api-ts's once did.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("REQUIRE_DB_TESTS") != "" {
			t.Fatal("REQUIRE_DB_TESTS is set but TEST_DATABASE_URL is unset")
		}
		t.Skip("TEST_DATABASE_URL unset")
	}
	return url
}

// ensureMigrated runs the app's own migration runner (see voting/pgtest_test.go).
func ensureMigrated(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := pg.Up(context.Background(), pool, dbmigrations.Files); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}
