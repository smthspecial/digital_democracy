package delegation

// Postgres-backed Store tests (ADR-029). See voting/pgstore_test.go for the
// TEST_DATABASE_URL contract.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func pgTestStore(t *testing.T) *PGStore {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), testDatabaseURL(t))
	if err != nil {
		t.Fatalf("pg connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ensureMigrated(t, pool)
	if _, err := pool.Exec(context.Background(), "TRUNCATE delegation"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return NewPGStore(pool)
}

// DP-014/015/041/045 hold on Postgres: cycle rejection, revocation,
// chain resolution, expiry sweep.
func TestPGDelegationLifecycle(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil, nil)
	now := time.Now().UTC()
	domain := newID()
	a, b, c := newID(), newID(), newID()
	future := now.Add(30 * 24 * time.Hour)

	dab, err := svc.Create(CreateInput{DelegatorID: a, DelegateID: b, DomainID: domain, ExpiresAt: future}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(CreateInput{DelegatorID: b, DelegateID: c, DomainID: domain, ExpiresAt: future}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(CreateInput{DelegatorID: c, DelegateID: a, DomainID: domain, ExpiresAt: future}, now); err != ErrConflict {
		t.Fatalf("cycle = %v, want ErrConflict", err)
	}

	chain, err := svc.ResolveChain(a, domain, now)
	if err != nil || len(chain) != 2 || chain[0] != b || chain[1] != c {
		t.Fatalf("chain = %v, %v", chain, err)
	}

	if _, err := svc.Revoke(dab.ID, a, now); err != nil {
		t.Fatal(err)
	}
	chain, err = svc.ResolveChain(a, domain, now)
	if err != nil || len(chain) != 0 {
		t.Fatalf("revoked chain = %v, %v", chain, err)
	}
	if _, err := pg.Get(dab.ID); err != nil {
		t.Fatal("revoked row must be retained")
	}

	short, err := svc.Create(CreateInput{DelegatorID: a, DelegateID: c, DomainID: newID(), ExpiresAt: now.Add(time.Hour)}, now)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := svc.ExpireDue(now.Add(2 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 || expired[0].ID != short.ID {
		t.Fatalf("expired = %v", expired)
	}
}
