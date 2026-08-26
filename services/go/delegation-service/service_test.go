package main

import (
	"errors"
	"sort"
	"sync"
	"testing"
	"time"
)

type fakeCompetencyChecker struct {
	mu        sync.Mutex
	competent map[string]bool // key: citizenID+"|"+domainID
	calls     []string
}

func newFakeCompetencyChecker() *fakeCompetencyChecker {
	return &fakeCompetencyChecker{competent: make(map[string]bool)}
}

func (f *fakeCompetencyChecker) allow(citizenID, domainID string) {
	f.competent[citizenID+"|"+domainID] = true
}

func (f *fakeCompetencyChecker) HasActiveCompetency(citizenID, domainID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, citizenID+"|"+domainID)
	return f.competent[citizenID+"|"+domainID]
}

type fakeAuditEmitter struct {
	mu     sync.Mutex
	events []string
}

func (f *fakeAuditEmitter) Emit(event string, d *Delegation) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event)
}

func newTestService() (*Service, *fakeCompetencyChecker, *fakeAuditEmitter) {
	competency := newFakeCompetencyChecker()
	audit := &fakeAuditEmitter{}
	svc := NewService(NewStore(), competency, audit)
	return svc, competency, audit
}

func TestCreateDelegationSuccess(t *testing.T) {
	svc, competency, audit := newTestService()
	competency.allow("bob", "healthcare")
	now := time.Now()
	expires := now.Add(24 * time.Hour)

	d, err := svc.CreateDelegation("alice", "bob", "healthcare", expires, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.ID == "" {
		t.Fatalf("expected generated id")
	}
	if d.DelegatorID != "alice" || d.DelegateID != "bob" || d.DomainID != "healthcare" {
		t.Fatalf("unexpected delegation: %+v", d)
	}
	if !d.ExpiresAt.Equal(expires) {
		t.Fatalf("expected expires_at %v, got %v", expires, d.ExpiresAt)
	}
	if len(audit.events) != 1 || audit.events[0] != "delegation.created" {
		t.Fatalf("expected one delegation.created audit event, got %v", audit.events)
	}
}

func TestCreateDelegationSelfRejected(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("alice", "healthcare")
	now := time.Now()
	_, err := svc.CreateDelegation("alice", "alice", "healthcare", now.Add(time.Hour), now)
	if !errors.Is(err, ErrSelfDelegation) {
		t.Fatalf("expected ErrSelfDelegation, got %v", err)
	}
}

func TestCreateDelegationExpiryMustBeFuture(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "healthcare")
	now := time.Now()

	cases := []struct {
		name    string
		expires time.Time
	}{
		{"equal to now", now},
		{"in the past", now.Add(-time.Hour)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.CreateDelegation("alice", "bob", "healthcare", tc.expires, now)
			if !errors.Is(err, ErrExpiryNotFuture) {
				t.Fatalf("expected ErrExpiryNotFuture, got %v", err)
			}
		})
	}
}

func TestCreateDelegationNoCompetencyRejected(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now()
	_, err := svc.CreateDelegation("alice", "bob", "healthcare", now.Add(time.Hour), now)
	if !errors.Is(err, ErrNoCompetency) {
		t.Fatalf("expected ErrNoCompetency, got %v", err)
	}
}

func TestCreateDelegationCircularRejectedDirect(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "d")
	competency.allow("alice", "d")
	now := time.Now()
	expires := now.Add(time.Hour)

	if _, err := svc.CreateDelegation("alice", "bob", "d", expires, now); err != nil {
		t.Fatalf("first delegation should succeed: %v", err)
	}
	_, err := svc.CreateDelegation("bob", "alice", "d", expires, now)
	if !errors.Is(err, ErrCircularDelegation) {
		t.Fatalf("expected ErrCircularDelegation, got %v", err)
	}
}

func TestCreateDelegationCircularRejectedTransitive(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("B", "d")
	competency.allow("C", "d")
	competency.allow("A", "d")
	now := time.Now()
	expires := now.Add(time.Hour)

	if _, err := svc.CreateDelegation("A", "B", "d", expires, now); err != nil {
		t.Fatalf("A->B should succeed: %v", err)
	}
	if _, err := svc.CreateDelegation("B", "C", "d", expires, now); err != nil {
		t.Fatalf("B->C should succeed: %v", err)
	}
	_, err := svc.CreateDelegation("C", "A", "d", expires, now)
	if !errors.Is(err, ErrCircularDelegation) {
		t.Fatalf("expected ErrCircularDelegation, got %v", err)
	}
}

func TestRevokeDelegation(t *testing.T) {
	svc, competency, audit := newTestService()
	competency.allow("bob", "healthcare")
	now := time.Now()
	d, err := svc.CreateDelegation("alice", "bob", "healthcare", now.Add(time.Hour), now)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	later := now.Add(time.Minute)
	got, err := svc.RevokeDelegation(d.ID, "alice", later)
	if err != nil {
		t.Fatalf("unexpected error revoking: %v", err)
	}
	if got.RevokedAt == nil || !got.RevokedAt.Equal(later) {
		t.Fatalf("expected revoked_at=%v, got %+v", later, got.RevokedAt)
	}
	if len(audit.events) != 2 || audit.events[1] != "delegation.revoked" {
		t.Fatalf("expected delegation.revoked audit event, got %v", audit.events)
	}
}

func TestRevokeDelegationNotOwner(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "healthcare")
	now := time.Now()
	d, _ := svc.CreateDelegation("alice", "bob", "healthcare", now.Add(time.Hour), now)

	_, err := svc.RevokeDelegation(d.ID, "eve", now)
	if !errors.Is(err, ErrNotDelegator) {
		t.Fatalf("expected ErrNotDelegator, got %v", err)
	}
}

func TestRevokeDelegationTwice(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "healthcare")
	now := time.Now()
	d, _ := svc.CreateDelegation("alice", "bob", "healthcare", now.Add(time.Hour), now)

	if _, err := svc.RevokeDelegation(d.ID, "alice", now); err != nil {
		t.Fatalf("first revoke should succeed: %v", err)
	}
	_, err := svc.RevokeDelegation(d.ID, "alice", now)
	if !errors.Is(err, ErrAlreadyRevoked) {
		t.Fatalf("expected ErrAlreadyRevoked, got %v", err)
	}
}

func TestRevokeDelegationUnknownID(t *testing.T) {
	svc, _, _ := newTestService()
	_, err := svc.RevokeDelegation("does-not-exist", "alice", time.Now())
	if !errors.Is(err, ErrDelegationNotFound) {
		t.Fatalf("expected ErrDelegationNotFound, got %v", err)
	}
}

func TestResolveChainMultiHopExcludesExpiredAndRevoked(t *testing.T) {
	svc, competency, _ := newTestService()
	for _, id := range []string{"A", "B", "C", "D"} {
		competency.allow(id, "d")
	}
	now := time.Now()
	future := now.Add(time.Hour)

	// C -> B -> A (transitive chain terminating at A)
	if _, err := svc.CreateDelegation("B", "A", "d", future, now); err != nil {
		t.Fatalf("B->A: %v", err)
	}
	if _, err := svc.CreateDelegation("C", "B", "d", future, now); err != nil {
		t.Fatalf("C->B: %v", err)
	}
	// D -> A direct, but revoked immediately -- must be excluded.
	revoked, err := svc.CreateDelegation("D", "A", "d", future, now)
	if err != nil {
		t.Fatalf("D->A: %v", err)
	}
	if _, err := svc.RevokeDelegation(revoked.ID, "D", now); err != nil {
		t.Fatalf("revoke D->A: %v", err)
	}
	// E -> A already expired -- must be excluded.
	svc.store.InsertIfAcyclic(&Delegation{
		ID: "expired-1", DelegatorID: "E", DelegateID: "A", DomainID: "d",
		CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour),
	}, now.Add(-2*time.Hour))

	got, err := svc.ResolveChain("A", "d", now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sort.Strings(got)
	want := []string{"B", "C"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestExpireDelegationsIdempotentAtServiceLayer(t *testing.T) {
	svc, competency, audit := newTestService()
	competency.allow("bob", "d")
	now := time.Now()
	// insert directly with an already-past expiry
	svc.store.InsertIfAcyclic(&Delegation{
		ID: "id-1", DelegatorID: "alice", DelegateID: "bob", DomainID: "d",
		CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour),
	}, now.Add(-2*time.Hour))

	count, err := svc.ExpireDelegations(now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected count=1, got %d", count)
	}

	count2, err := svc.ExpireDelegations(now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count2 != 0 {
		t.Fatalf("expected second call to affect 0, got %d", count2)
	}

	found := false
	for _, e := range audit.events {
		if e == "delegation.expired" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a delegation.expired audit event, got %v", audit.events)
	}
}

func TestListDelegationsFilters(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "healthcare")
	competency.allow("dave", "transportation")
	now := time.Now()
	svc.CreateDelegation("alice", "bob", "healthcare", now.Add(time.Hour), now)
	svc.CreateDelegation("carol", "dave", "transportation", now.Add(time.Hour), now)

	got := svc.ListDelegations(ListFilter{DomainID: "healthcare"})
	if len(got) != 1 || got[0].DelegatorID != "alice" {
		t.Fatalf("unexpected filtered list: %+v", got)
	}
}

func TestDefaultCompetencyCheckerAllowsAll(t *testing.T) {
	c := defaultCompetencyChecker{}
	if !c.HasActiveCompetency("anyone", "any-domain") {
		t.Fatalf("expected default competency checker to allow all")
	}
}

func TestNoopAuditEmitterDoesNotPanic(t *testing.T) {
	var e noopAuditEmitter
	e.Emit("anything", &Delegation{})
}
