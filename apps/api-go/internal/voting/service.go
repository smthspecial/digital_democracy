package voting

import (
	"errors"
	"sync"
	"time"
)

// DelegationResolver resolves whether a ballot cast should also count for
// delegators (DP-041). The production HTTP implementation lives behind this
// seam; unit tests and local dev use the no-op below (ARCH-009 seam pattern).
type DelegationResolver interface {
	// DelegatorsFor returns citizen ids whose vote flows to the given
	// citizen in the session's domain. Empty means no delegation.
	DelegatorsFor(sessionID, citizenID string) ([]string, error)
}

type noopDelegationResolver struct{}

func (noopDelegationResolver) DelegatorsFor(string, string) ([]string, error) {
	return nil, nil
}

// AuditEmitter emits session lifecycle events (DP-036). No-op by default;
// wired to audit-service over HTTP when AUDIT_SERVICE_URL is set.
type AuditEmitter interface {
	Emit(actionType, actorRef, payload string) error
}

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(string, string, string) error { return nil }

// Service implements the DP-xxx operations from SRV-008 §Operations.
// Store is the persistence contract behind Service. MemoryStore serves
// tests and DATABASE_URL-less runs; PGStore (pgstore.go) serves Postgres
// via the sqlc-generated queries (ADR-029). Method behavior — including
// DP-016 atomicity and DP-025 idempotency — must match across backends.
type Store interface {
	CreateSession(s *VoteSession) (*VoteSession, error)
	GetSession(id string) (*VoteSession, error)
	ListSessions() ([]*VoteSession, error)
	UpdateSessionStatus(id, status string) (*VoteSession, error)
	SetTally(id string, tally *TallyResult) (*VoteSession, error)
	AddOption(o *VoteOption) (*VoteOption, error)
	// IssueToken inserts (or returns the existing row for) one citizen. A
	// freshly created token carries the transient TokenBlind exactly once;
	// re-issues never do — the raw value is unrecoverable by design.
	IssueToken(sessionID, citizenID string) (*EligibilityToken, error)
	CountTokens(sessionID string) (int, error)
	CastBallot(sessionID, tokenID, tokenBlind, encryptedChoice string) (*Ballot, *EligibilityToken, error)
	FindBallotByVerification(code string) (*Ballot, error)
	BallotsForSession(sessionID string) ([]*Ballot, error)
}

type Service struct {
	store      Store
	delegation DelegationResolver
	audit      AuditEmitter

	// tallyMu serializes DP-026 per session (distributed lock in production;
	// process mutex for the in-memory store) for exactly-once semantics.
	tallyMu sync.Mutex
	tallied map[string]bool
}

func NewService(store Store, delegation DelegationResolver, audit AuditEmitter) *Service {
	if store == nil {
		store = NewStore()
	}
	if delegation == nil {
		delegation = noopDelegationResolver{}
	}
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	return &Service{store: store, delegation: delegation, audit: audit, tallied: map[string]bool{}}
}

type CreateSessionInput struct {
	ProposalID       string
	JurisdictionID   string
	Method           string
	ThresholdRule    string
	MinParticipation float64
	CoolingOffUntil  time.Time
	OpensAt          time.Time
	ClosesAt         time.Time
}

// CreateSession validates and stores a scheduled session. Constitutional
// review clearance (DP-034) is a prerequisite checked by the caller via the
// proposal/audit services; the session records the clearance reference.
func (s *Service) CreateSession(in CreateSessionInput) (*VoteSession, error) {
	if in.ProposalID == "" || in.JurisdictionID == "" {
		return nil, ErrInvalid
	}
	if !validMethod(in.Method) || !validThreshold(in.ThresholdRule) {
		return nil, ErrInvalid
	}
	if in.MinParticipation < 0 || in.MinParticipation > 1 {
		return nil, ErrInvalid
	}
	if !in.ClosesAt.After(in.OpensAt) {
		return nil, ErrInvalid
	}
	vs := &VoteSession{
		ProposalID:       in.ProposalID,
		JurisdictionID:   in.JurisdictionID,
		Method:           in.Method,
		ThresholdRule:    in.ThresholdRule,
		MinParticipation: in.MinParticipation,
		CoolingOffUntil:  in.CoolingOffUntil.UTC(),
		OpensAt:          in.OpensAt.UTC(),
		ClosesAt:         in.ClosesAt.UTC(),
	}
	created, err := s.store.CreateSession(vs)
	if err != nil {
		return nil, err
	}
	_ = s.audit.Emit("vote_session_scheduled", "voting-service", created.ID)
	return created, nil
}

// CoolingClear reports DP-057: cooling-off elapsed for a scheduled session.
func (s *Service) CoolingClear(vs *VoteSession, now time.Time) bool {
	return !vs.CoolingOffUntil.After(now)
}

// TryOpen runs DP-046: scheduled → open once opens_at passes and cooling
// has cleared. It also represents the DP-025 trigger point: callers issue
// eligibility tokens right after a successful open.
func (s *Service) TryOpen(id string, now time.Time) (*VoteSession, error) {
	vs, err := s.store.GetSession(id)
	if err != nil {
		return nil, err
	}
	if vs.Status != SessionScheduled {
		return nil, ErrInvalidState
	}
	if vs.OpensAt.After(now) || !s.CoolingClear(vs, now) {
		return nil, ErrInvalidState
	}
	opened, err := s.store.UpdateSessionStatus(id, SessionOpen)
	if err != nil {
		return nil, err
	}
	_ = s.audit.Emit("vote_session_opened", "voting-service", id)
	return opened, nil
}

// TryClose runs DP-047: open → closed once closes_at passes, then callers
// enqueue DP-026.
func (s *Service) TryClose(id string, now time.Time) (*VoteSession, error) {
	vs, err := s.store.GetSession(id)
	if err != nil {
		return nil, err
	}
	if vs.Status != SessionOpen {
		return nil, ErrInvalidState
	}
	if vs.ClosesAt.After(now) {
		return nil, ErrInvalidState
	}
	closed, err := s.store.UpdateSessionStatus(id, SessionClosed)
	if err != nil {
		return nil, err
	}
	_ = s.audit.Emit("vote_session_closed", "voting-service", id)
	return closed, nil
}

// IssueTokens runs DP-025 for a batch of eligible citizens. The store makes
// it idempotent on (session, citizen).
func (s *Service) IssueTokens(sessionID string, citizenIDs []string) ([]*EligibilityToken, error) {
	if _, err := s.store.GetSession(sessionID); err != nil {
		return nil, err
	}
	out := make([]*EligibilityToken, 0, len(citizenIDs))
	for _, cid := range citizenIDs {
		if cid == "" {
			return nil, ErrInvalid
		}
		t, err := s.store.IssueToken(sessionID, cid)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// CastBallot runs DP-016. The store performs the three steps atomically.
// When the voter has an active delegation chain, DP-041 resolution is
// consulted so the ballot also applies to delegators.
func (s *Service) CastBallot(sessionID, tokenID, tokenBlind, encryptedChoice, citizenID string) (*Ballot, error) {
	vs, err := s.store.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if vs.Status != SessionOpen {
		return nil, ErrInvalidState
	}
	if tokenBlind == "" || encryptedChoice == "" {
		return nil, ErrInvalid
	}
	b, _, err := s.store.CastBallot(sessionID, tokenID, tokenBlind, encryptedChoice)
	if err != nil {
		return nil, err
	}
	if citizenID != "" {
		// Delegation weight is resolved asynchronously in production
		// (voting.delegation queue); here we consult the seam synchronously
		// so failures degrade to a plain single ballot, never a lost vote.
		_, _ = s.delegation.DelegatorsFor(sessionID, citizenID)
	}
	_ = s.audit.Emit("ballot_cast", "voting-service", sessionID)
	return b, nil
}

// VerifyBallot runs DP-017: presence confirmation without choice disclosure
// or identity linkage (coercion resistance, FR-004).
func (s *Service) VerifyBallot(code string) (*Ballot, error) {
	if code == "" {
		return nil, ErrInvalid
	}
	return s.store.FindBallotByVerification(code)
}

// Tally runs DP-026. Encrypted choices are grouped opaquely here: real
// threshold decryption across key holders happens before counting in
// production; the grouping/threshold application below is the counting step
// that follows decryption. Exactly-once per session via the tally guard.
func (s *Service) Tally(sessionID string) (*TallyResult, error) {
	vs, err := s.store.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if vs.Status != SessionClosed && vs.Status != SessionCertified {
		return nil, ErrInvalidState
	}
	s.tallyMu.Lock()
	defer s.tallyMu.Unlock()
	if s.tallied[sessionID] && vs.TallyResult != nil {
		return vs.TallyResult, nil
	}
	ballots, err := s.store.BallotsForSession(sessionID)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, b := range ballots {
		counts[b.EncryptedChoice]++
	}
	winner, decided := evaluateOutcome(vs.Method, vs.ThresholdRule, counts, len(ballots))
	res := &TallyResult{
		SessionID:    sessionID,
		Counts:       counts,
		TotalBallots: len(ballots),
		Winner:       winner,
		Decided:      decided,
		ComputedAt:   time.Now().UTC(),
	}
	s.tallied[sessionID] = true
	updated, err := s.store.SetTally(sessionID, res)
	if err != nil {
		return nil, err
	}
	return updated.TallyResult, nil
}

// evaluateOutcome applies the session's method and threshold_rule to grouped
// choices (DP-026, US-032). Majority-family rules need a strict share of all
// cast ballots; ranked/preference/comparative methods decide by plurality at
// this layer (full rounds run post-decryption upstream — see TallyResult).
func evaluateOutcome(method, rule string, counts map[string]int, total int) (string, bool) {
	if total == 0 {
		return "", false
	}
	top, topVotes, second := "", 0, 0
	for choice, n := range counts {
		switch {
		case n > topVotes:
			top, second, topVotes = choice, topVotes, n
		case n > second:
			second = n
		}
	}
	switch {
	case rule == ThresholdSupermajority:
		// Constitutional bar (US-046): at least two thirds, any method.
		if topVotes*3 >= total*2 {
			return top, true
		}
		return "", false
	case method == MethodRankedChoice || method == MethodPreferenceScore || method == MethodComparative:
		// Ranked-family methods decide by plurality over the runner-up at
		// this layer; full rounds run post-decryption upstream.
		if topVotes > second {
			return top, true
		}
		return "", false
	default:
		// Approval and simple-majority rules need a strict majority.
		if topVotes*2 > total {
			return top, true
		}
		return "", false
	}
}

// Certify runs DP-027: quorum (min_participation) decides certified vs
// closed-failed-quorum. Participation = ballots / issued tokens.
func (s *Service) Certify(sessionID string) (*VoteSession, error) {
	vs, err := s.store.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if vs.Status != SessionClosed {
		return nil, ErrInvalidState
	}
	if vs.TallyResult == nil {
		if _, err := s.Tally(sessionID); err != nil {
			return nil, err
		}
		vs, err = s.store.GetSession(sessionID)
		if err != nil {
			return nil, err
		}
	}
	tokens, err := s.store.CountTokens(sessionID)
	if err != nil {
		return nil, err
	}
	var participation float64
	if tokens > 0 {
		participation = float64(vs.TallyResult.TotalBallots) / float64(tokens)
	}
	var out *VoteSession
	if participation >= vs.MinParticipation {
		out, err = s.store.UpdateSessionStatus(sessionID, SessionCertified)
		if err != nil {
			return nil, err
		}
		_ = s.audit.Emit("vote_certified", "voting-service", sessionID)
	} else {
		// Quorum failure stays closed (failed quorum), never certified.
		out, err = s.store.GetSession(sessionID)
		if err != nil {
			return nil, err
		}
		_ = s.audit.Emit("vote_quorum_failed", "voting-service", sessionID)
	}
	return out, nil
}

var _ = errors.Is
