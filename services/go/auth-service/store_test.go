package main

import (
	"sync"
	"testing"
	"time"
)

func TestStoreCreateAndGetSession(t *testing.T) {
	store := newStore()
	sess := Session{CitizenID: "citizen-1", AccessTokenHash: "access-hash-1", RefreshTokenHash: "refresh-hash-1", Status: SessionActive}

	created := store.CreateSession(sess)
	if created.ID == "" {
		t.Fatalf("expected an ID to be assigned")
	}

	got, ok := store.GetSession(created.ID)
	if !ok {
		t.Fatalf("expected session to be found by ID")
	}
	if got.CitizenID != "citizen-1" {
		t.Errorf("CitizenID = %q, want citizen-1", got.CitizenID)
	}

	byAccess, ok := store.GetSessionByAccessHash("access-hash-1")
	if !ok || byAccess.ID != created.ID {
		t.Errorf("expected lookup by access hash to find session %s", created.ID)
	}

	byRefresh, ok := store.GetSessionByRefreshHash("refresh-hash-1")
	if !ok || byRefresh.ID != created.ID {
		t.Errorf("expected lookup by refresh hash to find session %s", created.ID)
	}
}

func TestStoreSaveSessionReindexesOnRotationAndSupersedesOldHash(t *testing.T) {
	store := newStore()
	created := store.CreateSession(Session{CitizenID: "citizen-1", AccessTokenHash: "access-1", RefreshTokenHash: "refresh-1", Status: SessionActive})

	updated := created
	updated.RefreshTokenHash = "refresh-2"
	store.SaveSession(updated)

	if _, ok := store.GetSessionByRefreshHash("refresh-1"); ok {
		t.Errorf("expected old refresh hash to no longer resolve directly")
	}
	if sid, ok := store.RefreshHashSuperseded("refresh-1"); !ok || sid != created.ID {
		t.Errorf("expected refresh-1 to be marked superseded pointing at %s, got sid=%q ok=%v", created.ID, sid, ok)
	}
	got, ok := store.GetSessionByRefreshHash("refresh-2")
	if !ok || got.ID != created.ID {
		t.Errorf("expected new refresh hash to resolve to session")
	}
}

func TestStoreFactorsByCitizenAndType(t *testing.T) {
	store := newStore()
	store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorTOTP, Status: FactorActive})
	store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorPasskey, Status: FactorActive})
	revoked := store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorFacial, Status: FactorRevoked})
	store.CreateFactor(MFAFactor{CitizenID: "c2", FactorType: FactorTOTP, Status: FactorActive})

	types := store.ActiveFactorTypes("c1")
	if len(types) != 2 {
		t.Fatalf("expected 2 active factor types for c1, got %v", types)
	}

	if _, ok := store.ActiveFactor("c1", FactorFacial); ok {
		t.Errorf("expected revoked facial factor to not be returned as active")
	}
	if f, ok := store.ActiveFactor("c1", FactorTOTP); !ok || f.CitizenID != "c1" {
		t.Errorf("expected active totp factor for c1")
	}
	_ = revoked
}

func TestStoreAppendEventIsAppendOnly(t *testing.T) {
	store := newStore()
	e1 := store.AppendEvent(AuthEvent{CitizenID: "c1", EventType: EventLoginSuccess})
	e2 := store.AppendEvent(AuthEvent{CitizenID: "c1", EventType: EventLoginFailure})

	if e1.ID == "" || e2.ID == "" || e1.ID == e2.ID {
		t.Fatalf("expected distinct assigned IDs, got %q and %q", e1.ID, e2.ID)
	}
	events := store.Events()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
}

func TestStoreRecordFailurePrunesOutsideWindow(t *testing.T) {
	store := newStore()
	base := time.Unix(1_700_000_000, 0).UTC()
	window := 10 * time.Minute

	for i := 0; i < 3; i++ {
		store.RecordFailure("c1", base.Add(time.Duration(i)*time.Minute), window)
	}
	count := store.RecordFailure("c1", base.Add(3*time.Minute), window)
	if count != 4 {
		t.Fatalf("expected count 4, got %d", count)
	}

	// this failure is 20 minutes after the first ones, well outside the 10-minute window
	count = store.RecordFailure("c1", base.Add(25*time.Minute), window)
	if count != 1 {
		t.Fatalf("expected stale failures pruned, count = %d, want 1", count)
	}

	store.ResetFailures("c1")
	count = store.RecordFailure("c1", base.Add(26*time.Minute), window)
	if count != 1 {
		t.Fatalf("expected counter reset, count = %d, want 1", count)
	}
}

func TestStorePurgeSessionsRespectsPredicate(t *testing.T) {
	store := newStore()
	keep := store.CreateSession(Session{CitizenID: "c1", Status: SessionRevoked})
	remove := store.CreateSession(Session{CitizenID: "c1", Status: SessionSuspended})

	n := store.PurgeSessions(func(s Session) bool { return s.Status != SessionRevoked })
	if n != 1 {
		t.Fatalf("expected 1 purged, got %d", n)
	}
	if _, ok := store.GetSession(remove.ID); ok {
		t.Errorf("expected purged session to be gone")
	}
	if _, ok := store.GetSession(keep.ID); !ok {
		t.Errorf("expected revoked session to remain")
	}
}

func TestStoreConcurrentAccess(t *testing.T) {
	store := newStore()
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})
		}(i)
		go func(i int) {
			defer wg.Done()
			store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorTOTP, Status: FactorActive})
		}(i)
		go func(i int) {
			defer wg.Done()
			store.AppendEvent(AuthEvent{CitizenID: "c1", EventType: EventLoginSuccess})
		}(i)
	}
	wg.Wait()

	if len(store.Events()) != 100 {
		t.Fatalf("expected 100 events, got %d", len(store.Events()))
	}
}
