package main

import (
	"sync"
	"testing"
	"time"
)

func TestStoreAppendChainsSequentialEntries(t *testing.T) {
	s := NewStore()

	e1, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": 1}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e1.PrevHash != genesisHash {
		t.Fatalf("expected first entry to link to genesis, got %q", e1.PrevHash)
	}

	e2, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": 2}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if e2.PrevHash != computeRowHash(*e1) {
		t.Fatalf("expected second entry to link to first entry's row hash")
	}

	entries := s.ListLog("")
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
}

func TestStoreAppendIdempotency(t *testing.T) {
	s := NewStore()

	e1, err := s.Append(ActionAdminAction, "system:test", map[string]any{"a": 1}, "dedupe-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	e2, err := s.Append(ActionAdminAction, "system:test", map[string]any{"a": 999}, "dedupe-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if e1.ID != e2.ID {
		t.Fatalf("expected same entry to be returned for repeated idempotency key, got %q vs %q", e1.ID, e2.ID)
	}

	entries := s.ListLog("")
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 stored entry, got %d", len(entries))
	}
}

func TestStoreAppendRejectsInvalidActionType(t *testing.T) {
	s := NewStore()
	_, err := s.Append(ActionType("not_a_real_type"), "system:test", map[string]any{}, "")
	if err == nil {
		t.Fatalf("expected an error for invalid action type")
	}
	var domainErr *DomainError
	if !isDomainErrKind(err, KindValidation) {
		t.Fatalf("expected validation error, got %v (%T)", err, domainErr)
	}
}

func TestStoreListLogFiltersByActionType(t *testing.T) {
	s := NewStore()
	if _, err := s.Append(ActionSystemUpdate, "a", 1, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := s.Append(ActionRuleChange, "b", 2, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := s.Append(ActionSystemUpdate, "c", 3, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	filtered := s.ListLog(ActionSystemUpdate)
	if len(filtered) != 2 {
		t.Fatalf("expected 2 filtered entries, got %d", len(filtered))
	}
	for _, e := range filtered {
		if e.ActionType != ActionSystemUpdate {
			t.Fatalf("unexpected action type in filtered results: %q", e.ActionType)
		}
	}
}

func TestStoreLinkEntryBuffersOutOfOrderThenFlushes(t *testing.T) {
	s := NewStore()
	key := s.signingKey

	entryA, err := buildEntry("id-a", ActionSystemUpdate, "system:test", map[string]any{"step": "a"}, genesisHash, time.Now(), key)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rowHashA := computeRowHash(entryA)

	entryB, err := buildEntry("id-b", ActionSystemUpdate, "system:test", map[string]any{"step": "b"}, rowHashA, time.Now(), key)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if inChain := s.linkEntry(entryB); inChain {
		t.Fatalf("expected entry B to be buffered, not yet in chain")
	}
	if len(s.ListLog("")) != 0 {
		t.Fatalf("expected chain to still be empty while B is buffered")
	}

	if inChain := s.linkEntry(entryA); !inChain {
		t.Fatalf("expected entry A to link immediately")
	}

	entries := s.ListLog("")
	if len(entries) != 2 {
		t.Fatalf("expected both A and B in chain after A arrives, got %d entries", len(entries))
	}
	if entries[0].ID != "id-a" || entries[1].ID != "id-b" {
		t.Fatalf("expected order [A, B], got [%s, %s]", entries[0].ID, entries[1].ID)
	}
}

func TestStoreRecordReviewAndListReviews(t *testing.T) {
	s := NewStore()
	right, err := s.CreateRight("freedom of speech", "d", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	s.recordReview(ConstitutionalReview{
		ID:          generateID(),
		ProposalID:  "prop-1",
		RightID:     right.ID,
		Result:      ResultCleared,
		ReviewerRef: reviewerRef,
		CreatedAt:   time.Now().UTC(),
	})

	reviews := s.ListReviews()
	if len(reviews) != 1 {
		t.Fatalf("expected 1 review, got %d", len(reviews))
	}
	if reviews[0].RightID != right.ID {
		t.Fatalf("expected review to reference right %q, got %q", right.ID, reviews[0].RightID)
	}
}

func TestStoreConcurrentReadsWhileAppending(t *testing.T) {
	s := NewStore()
	var wg sync.WaitGroup

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if _, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": n}, ""); err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.ListLog("")
			_, _, _ = s.VerifyChainIntegrity()
		}()
	}

	wg.Wait()

	if len(s.ListLog("")) != 20 {
		t.Fatalf("expected 20 entries, got %d", len(s.ListLog("")))
	}
}

func isDomainErrKind(err error, kind ErrorKind) bool {
	de, ok := err.(*DomainError)
	return ok && de.Kind == kind
}
