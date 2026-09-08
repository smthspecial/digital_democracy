package delegation

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testService() *Service { return NewService(nil, nil, nil) }

func create(t *testing.T, svc *Service, delegator, delegate, domain string, expires time.Time) *Delegation {
	t.Helper()
	d, err := svc.Create(CreateInput{
		DelegatorID: delegator, DelegateID: delegate, DomainID: domain, ExpiresAt: expires,
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return d
}

func future() time.Time { return time.Now().UTC().Add(30 * 24 * time.Hour) }

// DP-014 validates input; expires_at is mandatory (no permanent delegates).
func TestCreateValidation(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	for _, in := range []CreateInput{
		{DelegateID: "b", DomainID: "health", ExpiresAt: future()},
		{DelegatorID: "a", DomainID: "health", ExpiresAt: future()},
		{DelegatorID: "a", DelegateID: "b", ExpiresAt: future()},
		{DelegatorID: "a", DelegateID: "a", DomainID: "health", ExpiresAt: future()},
		{DelegatorID: "a", DelegateID: "b", DomainID: "health"},
		{DelegatorID: "a", DelegateID: "b", DomainID: "health", ExpiresAt: now.Add(-time.Hour)},
	} {
		if _, err := svc.Create(in, now); err != ErrInvalid {
			t.Fatalf("Create(%+v) = %v, want ErrInvalid", in, err)
		}
	}
}

// FR-056: delegates without active competency are rejected (seam fails closed
// here via a stub checker).
func TestCreateRejectsIncompetentDelegate(t *testing.T) {
	svc := NewService(nil, CompetencyCheckerFunc(func(string, string) (bool, error) {
		return false, nil
	}), nil)
	_, err := svc.Create(CreateInput{DelegatorID: "a", DelegateID: "b", DomainID: "health", ExpiresAt: future()}, time.Now().UTC())
	if err != ErrInvalid {
		t.Fatalf("Create = %v, want ErrInvalid", err)
	}
}

// DP-014 rejects circular graphs at creation time, so DP-041 chains are
// always acyclic.
func TestCycleRejected(t *testing.T) {
	svc := testService()
	create(t, svc, "a", "b", "health", future())
	create(t, svc, "b", "c", "health", future())
	if _, err := svc.Create(CreateInput{DelegatorID: "c", DelegateID: "a", DomainID: "health", ExpiresAt: future()}, time.Now().UTC()); err != ErrConflict {
		t.Fatalf("closing the loop = %v, want ErrConflict", err)
	}
	// Same citizens in another domain are unaffected (domain-scoped, FR-056).
	create(t, svc, "c", "a", "transport", future())
}

// DP-041 resolves the full forward chain.
func TestResolveChain(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	create(t, svc, "a", "b", "health", future())
	create(t, svc, "b", "c", "health", future())
	chain, err := svc.ResolveChain("a", "health", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 2 || chain[0] != "b" || chain[1] != "c" {
		t.Fatalf("chain = %v", chain)
	}
	got, err := svc.ResolveChain("zzz", "health", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("unknown citizen chain = %v", got)
	}
}

// DP-015: revocation is immediate, the row survives, and only the delegator
// may revoke.
func TestRevoke(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	d := create(t, svc, "a", "b", "health", future())
	if _, err := svc.Revoke(d.ID, "intruder", now); err != ErrInvalid {
		t.Fatalf("foreign revoke = %v, want ErrInvalid", err)
	}
	revoked, err := svc.Revoke(d.ID, "a", now)
	if err != nil || revoked.RevokedAt == nil {
		t.Fatalf("Revoke = %v, %v", revoked, err)
	}
	// Revoked delegations no longer resolve.
	got, err := svc.ResolveChain("a", "health", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("revoked chain = %v", got)
	}
	// The row is retained for audit.
	if _, err := svc.store.Get(d.ID); err != nil {
		t.Fatal("revoked row was deleted")
	}
}

// DP-045: daily sweep revokes everything past expires_at.
func TestExpireDue(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	d := create(t, svc, "a", "b", "health", now.Add(time.Hour))
	out, err := svc.ExpireDue(now.Add(2 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].ID != d.ID {
		t.Fatalf("ExpireDue = %v", out)
	}
	got, err := svc.ResolveChain("a", "health", now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("expired chain = %v", got)
	}
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(NewRouter(testService(), nil))
	defer srv.Close()
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", path, resp.StatusCode)
		}
	}
}

var _ = errors.Is

// CompetencyCheckerFunc adapts a function to the seam interface.
type CompetencyCheckerFunc func(citizenID, domainID string) (bool, error)

func (f CompetencyCheckerFunc) HasActiveCompetency(citizenID, domainID string) (bool, error) {
	return f(citizenID, domainID)
}
