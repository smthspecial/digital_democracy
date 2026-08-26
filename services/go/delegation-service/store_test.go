package main

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"
)

func mkDelegation(id, delegator, delegate, domain string, now time.Time) *Delegation {
	return &Delegation{
		ID:          id,
		DelegatorID: delegator,
		DelegateID:  delegate,
		DomainID:    domain,
		CreatedAt:   now,
		ExpiresAt:   now.Add(24 * time.Hour),
	}
}

func TestStoreInsertAndGet(t *testing.T) {
	s := NewStore()
	now := time.Now()
	d := mkDelegation("id-1", "alice", "bob", "healthcare", now)

	if err := s.InsertIfAcyclic(d, now); err != nil {
		t.Fatalf("InsertIfAcyclic returned error: %v", err)
	}

	got, ok := s.Get("id-1")
	if !ok {
		t.Fatalf("expected to find inserted delegation")
	}
	if got.DelegatorID != "alice" || got.DelegateID != "bob" {
		t.Fatalf("unexpected delegation contents: %+v", got)
	}

	// mutating the returned copy must not affect the store
	got.DelegatorID = "mutated"
	got2, _ := s.Get("id-1")
	if got2.DelegatorID != "alice" {
		t.Fatalf("store row was mutated via returned pointer: %+v", got2)
	}

	if _, ok := s.Get("missing"); ok {
		t.Fatalf("expected missing id to be not-found")
	}
}

func TestStoreListFilters(t *testing.T) {
	s := NewStore()
	now := time.Now()
	_ = s.InsertIfAcyclic(mkDelegation("id-1", "alice", "bob", "healthcare", now), now)
	_ = s.InsertIfAcyclic(mkDelegation("id-2", "carol", "bob", "healthcare", now), now)
	_ = s.InsertIfAcyclic(mkDelegation("id-3", "alice", "dave", "transportation", now), now)

	cases := []struct {
		name   string
		filter ListFilter
		want   []string
	}{
		{"no filter", ListFilter{}, []string{"id-1", "id-2", "id-3"}},
		{"by delegator", ListFilter{DelegatorID: "alice"}, []string{"id-1", "id-3"}},
		{"by delegate", ListFilter{DelegateID: "bob"}, []string{"id-1", "id-2"}},
		{"by domain", ListFilter{DomainID: "transportation"}, []string{"id-3"}},
		{"no match", ListFilter{DomainID: "nope"}, []string{}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := s.List(tc.filter)
			ids := make([]string, len(got))
			for i, d := range got {
				ids[i] = d.ID
			}
			sort.Strings(ids)
			sort.Strings(tc.want)
			if len(ids) != len(tc.want) {
				t.Fatalf("got %v, want %v", ids, tc.want)
			}
			for i := range ids {
				if ids[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", ids, tc.want)
				}
			}
		})
	}
}

func TestStoreInsertIfAcyclicDirectCycle(t *testing.T) {
	s := NewStore()
	now := time.Now()
	if err := s.InsertIfAcyclic(mkDelegation("id-1", "A", "B", "d", now), now); err != nil {
		t.Fatalf("first insert should succeed: %v", err)
	}
	err := s.InsertIfAcyclic(mkDelegation("id-2", "B", "A", "d", now), now)
	if !errors.Is(err, ErrCircularDelegation) {
		t.Fatalf("expected ErrCircularDelegation, got %v", err)
	}
	if _, ok := s.Get("id-2"); ok {
		t.Fatalf("rejected delegation must not be stored")
	}
}

func TestStoreInsertIfAcyclicTransitiveCycle(t *testing.T) {
	s := NewStore()
	now := time.Now()
	if err := s.InsertIfAcyclic(mkDelegation("id-1", "A", "B", "d", now), now); err != nil {
		t.Fatalf("A->B insert should succeed: %v", err)
	}
	if err := s.InsertIfAcyclic(mkDelegation("id-2", "B", "C", "d", now), now); err != nil {
		t.Fatalf("B->C insert should succeed: %v", err)
	}
	err := s.InsertIfAcyclic(mkDelegation("id-3", "C", "A", "d", now), now)
	if !errors.Is(err, ErrCircularDelegation) {
		t.Fatalf("expected ErrCircularDelegation, got %v", err)
	}
}

func TestStoreInsertIfAcyclicDifferentDomainNotACycle(t *testing.T) {
	s := NewStore()
	now := time.Now()
	if err := s.InsertIfAcyclic(mkDelegation("id-1", "A", "B", "healthcare", now), now); err != nil {
		t.Fatalf("insert should succeed: %v", err)
	}
	// B->A in a different domain is not a cycle: domains are isolated.
	if err := s.InsertIfAcyclic(mkDelegation("id-2", "B", "A", "transportation", now), now); err != nil {
		t.Fatalf("cross-domain insert should succeed, got %v", err)
	}
}

func TestStoreInsertIfAcyclicIgnoresExpiredEdges(t *testing.T) {
	s := NewStore()
	now := time.Now()
	expired := &Delegation{ID: "id-1", DelegatorID: "A", DelegateID: "B", DomainID: "d", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-1 * time.Hour)}
	if err := s.InsertIfAcyclic(expired, now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("insert should succeed: %v", err)
	}
	// A->B has already expired as of now, so B->A does not close a live cycle.
	if err := s.InsertIfAcyclic(mkDelegation("id-2", "B", "A", "d", now), now); err != nil {
		t.Fatalf("expected success since prior edge is expired, got %v", err)
	}
}

func TestStoreRevoke(t *testing.T) {
	s := NewStore()
	now := time.Now()
	d := mkDelegation("id-1", "alice", "bob", "healthcare", now)
	_ = s.InsertIfAcyclic(d, now)

	later := now.Add(time.Hour)
	got, err := s.Revoke("id-1", "alice", later)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.RevokedAt == nil || !got.RevokedAt.Equal(later) {
		t.Fatalf("expected revoked_at to be set to %v, got %+v", later, got.RevokedAt)
	}

	if _, err := s.Revoke("id-1", "alice", later); !errors.Is(err, ErrAlreadyRevoked) {
		t.Fatalf("expected ErrAlreadyRevoked, got %v", err)
	}

	if _, err := s.Revoke("missing", "alice", later); !errors.Is(err, ErrDelegationNotFound) {
		t.Fatalf("expected ErrDelegationNotFound, got %v", err)
	}

	d2 := mkDelegation("id-2", "carol", "dave", "healthcare", now)
	_ = s.InsertIfAcyclic(d2, now)
	if _, err := s.Revoke("id-2", "not-carol", later); !errors.Is(err, ErrNotDelegator) {
		t.Fatalf("expected ErrNotDelegator, got %v", err)
	}
}

func TestStoreExpireDelegationsIdempotent(t *testing.T) {
	s := NewStore()
	base := time.Now()
	expiring := &Delegation{ID: "id-1", DelegatorID: "A", DelegateID: "B", DomainID: "d", CreatedAt: base.Add(-2 * time.Hour), ExpiresAt: base.Add(-time.Hour)}
	_ = s.InsertIfAcyclic(expiring, base.Add(-2*time.Hour))
	stillActive := mkDelegation("id-2", "C", "D", "d", base)
	_ = s.InsertIfAcyclic(stillActive, base)

	first := s.ExpireDelegations(base)
	if len(first) != 1 || first[0].ID != "id-1" {
		t.Fatalf("expected exactly id-1 to be expired, got %+v", first)
	}

	second := s.ExpireDelegations(base)
	if len(second) != 0 {
		t.Fatalf("expected repeat call to affect nothing, got %+v", second)
	}

	stillActiveAfter, _ := s.Get("id-2")
	if stillActiveAfter.RevokedAt != nil {
		t.Fatalf("expected id-2 to remain unrevoked, got %+v", stillActiveAfter)
	}
}

func TestStoreReverseActiveWalk(t *testing.T) {
	s := NewStore()
	now := time.Now()
	// C -> B -> A chain (C delegates to B, B delegates to A) plus D -> A direct.
	_ = s.InsertIfAcyclic(mkDelegation("id-1", "B", "A", "d", now), now)
	_ = s.InsertIfAcyclic(mkDelegation("id-2", "C", "B", "d", now), now)
	_ = s.InsertIfAcyclic(mkDelegation("id-3", "D", "A", "d", now), now)
	// Unrelated domain edge must not be included.
	_ = s.InsertIfAcyclic(mkDelegation("id-4", "E", "A", "other", now), now)
	// Expired edge must be excluded.
	expired := &Delegation{ID: "id-5", DelegatorID: "F", DelegateID: "A", DomainID: "d", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)}
	_ = s.InsertIfAcyclic(expired, now.Add(-2*time.Hour))

	got := s.ReverseActiveWalk("A", "d", now)
	sort.Strings(got)
	want := []string{"B", "C", "D"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestStoreConcurrentAccess(t *testing.T) {
	s := NewStore()
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("id-%d", i)
			_ = s.InsertIfAcyclic(mkDelegation(id, fmt.Sprintf("delegator-%d", i), "shared-delegate", "d", now), now)
		}(i)
		go func() {
			defer wg.Done()
			_ = s.List(ListFilter{})
			_ = s.ReverseActiveWalk("shared-delegate", "d", now)
		}()
	}
	wg.Wait()
}
