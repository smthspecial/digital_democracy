package voting

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Independent pools/services model replicas without sharing process locks.
func replicaStore(t *testing.T) *PGStore {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), pgTestURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return NewPGStore(pool)
}

func TestPGVotingReplicaIssueAndSpend(t *testing.T) {
	first := pgTestStore(t)
	second := replicaStore(t)
	svc := NewService(first, nil, nil)
	session := pgTestSession(t, svc)
	citizen := newID()
	const attempts = 16
	type issueResult struct {
		token *EligibilityToken
		err   error
	}
	issued := make(chan issueResult, attempts)
	start := make(chan struct{})
	for i := range attempts {
		store := []*PGStore{first, second}[i%2]
		go func() {
			<-start
			token, err := store.IssueToken(session.ID, citizen)
			issued <- issueResult{token, err}
		}()
	}
	close(start)
	var credential *EligibilityToken
	var tokenID string
	for range attempts {
		result := <-issued
		if result.err != nil {
			t.Fatal(result.err)
		}
		if tokenID != "" && result.token.ID != tokenID {
			t.Fatal("replicas issued multiple tokens for one citizen")
		}
		tokenID = result.token.ID
		if result.token.TokenBlind != "" {
			if credential != nil {
				t.Fatal("raw credential returned more than once")
			}
			credential = result.token
		}
	}
	if credential == nil {
		t.Fatal("no credential was issued")
	}
	type castResult struct {
		ballot *Ballot
		err    error
	}
	cast := make(chan castResult, attempts)
	start = make(chan struct{})
	for i := range attempts {
		service := NewService([]*PGStore{first, second}[i%2], nil, nil)
		go func() {
			<-start
			ballot, err := service.CastBallot(session.ID, credential.ID, credential.TokenBlind, "choice", citizen)
			cast <- castResult{ballot, err}
		}()
	}
	close(start)
	var accepted *Ballot
	for range attempts {
		result := <-cast
		if result.err == nil {
			if accepted != nil {
				t.Fatal("credential spent more than once")
			}
			accepted = result.ballot
		} else if result.err != ErrConflict {
			t.Fatalf("cast: %v", result.err)
		}
	}
	if accepted == nil {
		t.Fatal("no ballot accepted")
	}
	// A fresh pool/service has no process state from the successful cast.
	restarted := NewService(replicaStore(t), nil, nil)
	found, err := restarted.VerifyBallot(accepted.VerificationCode)
	if err != nil || found.ID != accepted.ID {
		t.Fatalf("durable acknowledgement: %v, %v", found, err)
	}
	if _, err := restarted.CastBallot(session.ID, credential.ID, credential.TokenBlind, "choice", citizen); err != ErrConflict {
		t.Fatalf("spent token after restart: %v", err)
	}
	ballots, err := first.BallotsForSession(session.ID)
	if err != nil || len(ballots) != 1 || ballots[0].TokenBlind == credential.TokenBlind {
		t.Fatalf("stored ballots: %v, %v", ballots, err)
	}
}

func TestPGVotingIndependentBallotsShareSessionLock(t *testing.T) {
	store := pgTestStore(t)
	svc := NewService(store, nil, nil)
	session := pgTestSession(t, svc)
	citizen := newID()
	tokens, err := svc.IssueTokens(session.ID, []string{citizen})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Hold the same lock as another in-flight ballot. An independent token
	// must proceed, but an election close must wait for all ballot commits.
	if _, err := tx.Exec(ctx, "SELECT id FROM vote_session WHERE id=$1 FOR SHARE", session.ID); err != nil {
		t.Fatal(err)
	}
	other := replicaStore(t)
	if _, err := NewService(other, nil, nil).CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err != nil {
		t.Fatalf("independent ballot blocked by session lock: %v", err)
	}
	closeTx, err := other.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTx.Rollback(ctx)
	if _, err := closeTx.Exec(ctx, "SET LOCAL lock_timeout='100ms'"); err != nil {
		t.Fatal(err)
	}
	if _, err := closeTx.Exec(ctx, "UPDATE vote_session SET status='closed' WHERE id=$1", session.ID); err == nil {
		t.Fatal("close bypassed the in-flight ballot lock")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := other.UpdateSessionStatus(session.ID, SessionClosed); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err != ErrInvalidState {
		t.Fatalf("cast after close: %v", err)
	}
}

func testPersistedTally(t *testing.T, store Store) {
	t.Helper()
	svc := NewService(store, nil, nil)
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{ProposalID: newID(), JurisdictionID: newID(), Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority, OpensAt: now.Add(-time.Hour), ClosesAt: now.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	option, err := store.AddOption(&VoteOption{SessionID: session.ID, ProposalID: newID(), Label: "A"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryOpen(session.ID, now); err != nil {
		t.Fatal(err)
	}
	citizen := newID()
	tokens, err := svc.IssueTokens(session.ID, []string{citizen})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, option.ID, citizen); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryClose(session.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var restartedStore Store = store
	if _, ok := store.(*PGStore); ok {
		restartedStore = replicaStore(t)
	}
	restarted := NewService(restartedStore, nil, nil)
	const writers = 8
	type tallyResult struct {
		tally *TallyResult
		err   error
	}
	tallies := make(chan tallyResult, writers)
	start := make(chan struct{})
	for i := range writers {
		service := []*Service{svc, restarted}[i%2]
		go func() {
			<-start
			result, err := service.Tally(session.ID)
			tallies <- tallyResult{result, err}
		}()
	}
	close(start)
	var first *TallyResult
	for range writers {
		result := <-tallies
		if result.err != nil || result.tally == nil {
			t.Fatalf("concurrent tally: %v", result.err)
		}
		if first == nil {
			first = result.tally
		} else if !reflect.DeepEqual(first, result.tally) {
			t.Fatal("replicas returned different committed tallies")
		}
	}
	second, err := restarted.Tally(session.ID)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("restart changed the committed tally: %v, %v", second, err)
	}
	// Competing writers must return the first committed result, including its
	// timestamp, rather than replacing public evidence with a new computation.
	type writeResult struct {
		session *VoteSession
		err     error
	}
	results := make(chan writeResult, writers)
	for i := range writers {
		go func() {
			result, err := restartedStore.SetTally(session.ID, &TallyResult{SessionID: session.ID, Winner: "replacement", TotalBallots: i + 100})
			results <- writeResult{result, err}
		}()
	}
	for range writers {
		result := <-results
		if result.err != nil || result.session == nil || !reflect.DeepEqual(first, result.session.TallyResult) {
			t.Fatalf("writer replaced committed tally: %v, %v", result.session, result.err)
		}
	}
}

func TestTallySurvivesServiceRestart(t *testing.T) {
	testPersistedTally(t, NewStore())
}

func TestPGVotingReplicaTally(t *testing.T) {
	testPersistedTally(t, pgTestStore(t))
}

func TestPGVotingFailedSpendRollsBackBallot(t *testing.T) {
	store := pgTestStore(t)
	svc := NewService(store, nil, nil)
	session := pgTestSession(t, svc)
	citizen := newID()
	tokens, err := svc.IssueTokens(session.ID, []string{citizen})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// Fail the last write, after inserting the ballot. The transaction must
	// leave neither a ballot nor a consumed credential behind.
	if _, err := store.pool.Exec(ctx, `
		CREATE FUNCTION dd_test_reject_spend() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'synthetic spend failure'; END $$;
		CREATE TRIGGER dd_test_reject_spend BEFORE UPDATE ON eligibility_token
		FOR EACH ROW WHEN (NEW.used) EXECUTE FUNCTION dd_test_reject_spend();`); err != nil {
		t.Fatal(err)
	}
	cleanup := func() {
		_, err := store.pool.Exec(ctx, "DROP TRIGGER IF EXISTS dd_test_reject_spend ON eligibility_token; DROP FUNCTION IF EXISTS dd_test_reject_spend()")
		if err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(cleanup)
	if ballot, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err == nil || ballot != nil {
		t.Fatal("failed spend acknowledged a ballot")
	}
	ballots, err := store.BallotsForSession(session.ID)
	if err != nil || len(ballots) != 0 {
		t.Fatalf("ballot survived rollback: %v, %v", ballots, err)
	}
	var used bool
	if err := store.pool.QueryRow(ctx, "SELECT used FROM eligibility_token WHERE id=$1", tokens[0].ID).Scan(&used); err != nil || used {
		t.Fatalf("credential consumed by failed transaction: %v, %v", used, err)
	}
	cleanup()
	if _, err := NewService(replicaStore(t), nil, nil).CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err != nil {
		t.Fatalf("retry after recovery: %v", err)
	}
}

func TestPGVotingUnavailablePoolDoesNotSpend(t *testing.T) {
	store := pgTestStore(t)
	svc := NewService(store, nil, nil)
	session := pgTestSession(t, svc)
	citizen := newID()
	tokens, err := svc.IssueTokens(session.ID, []string{citizen})
	if err != nil {
		t.Fatal(err)
	}
	store.pool.Close()
	if ballot, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err == nil || ballot != nil {
		t.Fatal("unavailable database acknowledged a ballot")
	}
	if _, err := NewService(replicaStore(t), nil, nil).CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "choice", citizen); err != nil {
		t.Fatalf("retry after reconnect: %v", err)
	}
}

func TestPGVotingSessionListBounded(t *testing.T) {
	store := pgTestStore(t)
	svc := NewService(store, nil, nil)
	session := pgTestSession(t, svc)
	if _, err := store.pool.Exec(context.Background(), `
		INSERT INTO vote_session (id, proposal_id, jurisdiction_id, method, threshold_rule,
		min_participation, cooling_off_until, opens_at, closes_at, status)
		SELECT gen_random_uuid(), proposal_id, jurisdiction_id, method, threshold_rule,
		min_participation, cooling_off_until, opens_at, closes_at, status
		FROM vote_session CROSS JOIN generate_series(1,1000) WHERE id=$1`, session.ID); err != nil {
		t.Fatal(err)
	}
	sessions, err := store.ListSessions()
	if err != nil || len(sessions) != 1000 {
		t.Fatalf("bounded session listing: %d, %v", len(sessions), err)
	}
}
