package security

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	dbmigrations "github.com/digital-democracy/api-go/db"
	"github.com/digital-democracy/api-go/internal/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/url"
	"os"
	"testing"
	"time"
)

func TestRestrictedPostgresReplayAndAppendOnlyAudit(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("REQUIRE_DB_TESTS") != "" {
			t.Fatal("TEST_DATABASE_URL required")
		}
		t.Skip("disposable Postgres URL required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err = pg.Up(ctx, admin, dbmigrations.Files); err != nil {
		t.Fatal(err)
	}
	// Policy roles are NOLOGIN in provisioned environments. Exercise them through
	// a disposable login, without changing the production policy role itself.
	var roleRandom [8]byte
	if _, err := rand.Read(roleRandom[:]); err != nil {
		t.Fatal(err)
	}
	role := "security_test_" + hex.EncodeToString(roleRandom[:])
	quotedRole := pgx.Identifier{role}.Sanitize()
	if _, err = admin.Exec(ctx, fmt.Sprintf("CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'disposable_security_test' IN ROLE api_worker", quotedRole)); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, "DROP OWNED BY "+quotedRole); err != nil {
			t.Errorf("fixture grants cleanup: %v", err)
		}
		if _, err := admin.Exec(ctx, "DROP ROLE "+quotedRole); err != nil {
			t.Errorf("fixture role cleanup: %v", err)
		}
	}()
	var database string
	if err = admin.QueryRow(ctx, "SELECT current_database()").Scan(&database); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, "GRANT CONNECT ON DATABASE "+pgx.Identifier{database}.Sanitize()+" TO "+quotedRole); err != nil {
		t.Fatal(err)
	}
	target, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	target.User = url.UserPassword(role, "disposable_security_test")
	worker, err := pgxpool.New(ctx, target.String())
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	var privileged bool
	if err = worker.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&privileged); err != nil || privileged {
		t.Fatalf("privileged runtime: %v", err)
	}
	var random [16]byte
	rand.Read(random[:])
	key := "fixture:" + hex.EncodeToString(random[:])
	expires := time.Now().Add(time.Minute)
	first, second := &ReplayStore{Pool: worker}, &ReplayStore{Pool: worker}
	if !first.Claim(ctx, key, expires) || second.Claim(ctx, key, expires) {
		t.Fatal("replay consumed across independent instances")
	}
	if _, err = worker.Exec(ctx, "UPDATE audit_log SET actor_ref='forged' WHERE false"); err == nil {
		t.Fatal("runtime can rewrite audit history")
	}
	if _, err = worker.Exec(ctx, "CREATE TABLE forbidden_runtime_ddl(id int)"); err == nil {
		t.Fatal("runtime can create schema")
	}
}
