package main

import (
	"sync"
	"testing"
	"time"
)

func newTestSession(t *testing.T, st *store, status SessionStatus) *VoteSession {
	t.Helper()
	return newTestSessionClosesAt(t, st, status, time.Now().UTC().Add(time.Hour))
}

func newTestSessionClosesAt(t *testing.T, st *store, status SessionStatus, closesAt time.Time) *VoteSession {
	t.Helper()
	key, err := generateAESKey()
	if err != nil {
		t.Fatalf("generateAESKey: %v", err)
	}
	shares, err := shamirSplit(key, shamirShares, shamirThreshold)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	now := time.Now().UTC()
	s := &VoteSession{
		ID:               newID(),
		ProposalID:       "prop-1",
		JurisdictionID:   "juri-1",
		Method:           MethodApproval,
		ThresholdRule:    ThresholdSimpleMajority,
		MinParticipation: 0.5,
		CoolingOffUntil:  now.Add(-time.Hour),
		OpensAt:          now.Add(-time.Minute),
		ClosesAt:         closesAt,
		Status:           status,
		CreatedAt:        now,
	}
	st.CreateSession(s, shares)
	return s
}

func TestStoreIssueTokenIdempotent(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)

	created1, err := st.IssueToken(s.ID, "citizen-1", "hash-1", time.Now())
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if !created1 {
		t.Fatal("expected first issuance to be created=true")
	}

	created2, err := st.IssueToken(s.ID, "citizen-1", "hash-1-different", time.Now())
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if created2 {
		t.Fatal("expected re-issuance to the same citizen to be a no-op")
	}

	count, err := st.CountIssuedTokens(s.ID)
	if err != nil {
		t.Fatalf("CountIssuedTokens: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
}

func TestStoreCastBallotAtomicSuccess(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)
	if _, err := st.IssueToken(s.ID, "citizen-1", sha256Hex("secret-1"), time.Now()); err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	ballot, citizenID, proposalID, err := st.CastBallot(s.ID, "secret-1", "opt1", time.Now())
	if err != nil {
		t.Fatalf("CastBallot: %v", err)
	}
	if citizenID != "citizen-1" {
		t.Fatalf("citizenID = %q, want citizen-1", citizenID)
	}
	if proposalID != s.ProposalID {
		t.Fatalf("proposalID = %q, want %q", proposalID, s.ProposalID)
	}
	if ballot.VerificationCode == "" {
		t.Fatal("expected non-empty verification code")
	}

	found, err := st.HasBallotWithCode(s.ID, ballot.VerificationCode)
	if err != nil {
		t.Fatalf("HasBallotWithCode: %v", err)
	}
	if !found {
		t.Fatal("expected ballot to be found by verification code")
	}
}

func TestStoreCastBallotUnknownTokenFails(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)

	if _, _, _, err := st.CastBallot(s.ID, "no-such-secret", "opt1", time.Now()); err != ErrTokenNotFound {
		t.Fatalf("err = %v, want ErrTokenNotFound", err)
	}
}

func TestStoreCastBallotUsedTokenFails(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)
	if _, err := st.IssueToken(s.ID, "citizen-1", sha256Hex("secret-1"), time.Now()); err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if _, _, _, err := st.CastBallot(s.ID, "secret-1", "opt1", time.Now()); err != nil {
		t.Fatalf("first CastBallot: %v", err)
	}
	if _, _, _, err := st.CastBallot(s.ID, "secret-1", "opt1", time.Now()); err != ErrTokenUsed {
		t.Fatalf("err = %v, want ErrTokenUsed", err)
	}
}

func TestStoreCastBallotNotOpenFails(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusScheduled)
	if _, _, _, err := st.CastBallot(s.ID, "secret-1", "opt1", time.Now()); err != ErrSessionNotOpen {
		t.Fatalf("err = %v, want ErrSessionNotOpen", err)
	}
}

// TestStoreCastBallotConcurrentDoubleSpend hammers the same token from many
// goroutines and asserts exactly one CastBallot call succeeds -- the atomic
// check-and-mark-used critical section must never allow a double spend.
func TestStoreCastBallotConcurrentDoubleSpend(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)
	if _, err := st.IssueToken(s.ID, "citizen-1", sha256Hex("secret-1"), time.Now()); err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	const attempts = 100
	var wg sync.WaitGroup
	var successCount int
	var mu sync.Mutex

	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _, err := st.CastBallot(s.ID, "secret-1", "opt1", time.Now())
			if err == nil {
				mu.Lock()
				successCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if successCount != 1 {
		t.Fatalf("successCount = %d, want exactly 1", successCount)
	}

	count, err := st.CountIssuedTokens(s.ID)
	if err != nil {
		t.Fatalf("CountIssuedTokens: %v", err)
	}
	if count != 1 {
		t.Fatalf("token count = %d, want 1", count)
	}
}

// TestStoreConcurrentCastBallotDistinctCitizens exercises many concurrent
// distinct ballots to check for races (run with -race) and unique
// verification codes.
func TestStoreConcurrentCastBallotDistinctCitizens(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusOpen)

	const n = 200
	secrets := make([]string, n)
	for i := 0; i < n; i++ {
		citizenID := newID()
		secret := newID()
		secrets[i] = secret
		if _, err := st.IssueToken(s.ID, citizenID, sha256Hex(secret), time.Now()); err != nil {
			t.Fatalf("IssueToken: %v", err)
		}
	}

	var wg sync.WaitGroup
	codes := make([]string, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b, _, _, err := st.CastBallot(s.ID, secrets[i], "opt1", time.Now())
			errs[i] = err
			if err == nil {
				codes[i] = b.VerificationCode
			}
		}(i)
	}
	wg.Wait()

	seen := make(map[string]bool, n)
	for i, err := range errs {
		if err != nil {
			t.Fatalf("CastBallot[%d]: %v", i, err)
		}
		if seen[codes[i]] {
			t.Fatalf("duplicate verification code %q", codes[i])
		}
		seen[codes[i]] = true
	}
}

func TestStorePrepareCloseValidation(t *testing.T) {
	st := newStore()
	now := time.Now().UTC()

	notYetClosable := newTestSessionClosesAt(t, st, StatusOpen, now.Add(time.Hour))
	if _, _, _, err := st.PrepareClose(notYetClosable.ID, now); err != ErrCloseNotEligible {
		t.Fatalf("err = %v, want ErrCloseNotEligible", err)
	}

	notOpen := newTestSession(t, st, StatusScheduled)
	if _, _, _, err := st.PrepareClose(notOpen.ID, now); err != ErrSessionNotOpen {
		t.Fatalf("err = %v, want ErrSessionNotOpen", err)
	}

	if _, _, _, err := st.PrepareClose("no-such-session", now); err != ErrSessionNotFound {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

func TestStorePrepareCloseSucceedsAndTransitionsStatus(t *testing.T) {
	st := newStore()
	s := newTestSessionClosesAt(t, st, StatusOpen, time.Now().UTC().Add(-time.Minute))

	closed, ballots, issuedCount, err := st.PrepareClose(s.ID, time.Now().UTC())
	if err != nil {
		t.Fatalf("PrepareClose: %v", err)
	}
	if closed.Status != StatusClosed {
		t.Fatalf("status = %q, want closed", closed.Status)
	}
	if len(ballots) != 0 {
		t.Fatalf("expected zero ballots, got %d", len(ballots))
	}
	if issuedCount != 0 {
		t.Fatalf("expected zero issued tokens, got %d", issuedCount)
	}
}

func TestStoreGetKeySharesNeverExposesRawKey(t *testing.T) {
	st := newStore()
	s := newTestSession(t, st, StatusScheduled)

	shares, err := st.GetKeyShares(s.ID)
	if err != nil {
		t.Fatalf("GetKeyShares: %v", err)
	}
	if len(shares) != shamirShares {
		t.Fatalf("got %d shares, want %d", len(shares), shamirShares)
	}
	reconstructed, err := shamirCombine(shares[:shamirThreshold])
	if err != nil {
		t.Fatalf("shamirCombine: %v", err)
	}
	if len(reconstructed) != aesKeySize {
		t.Fatalf("reconstructed key length = %d, want %d", len(reconstructed), aesKeySize)
	}
}
