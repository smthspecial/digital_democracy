package main

import (
	"fmt"
	"strings"
	"time"
)

// DelegationResolver models DP-041 (delegation chain resolution), owned by
// SRV-010/delegation-service. There is no message queue to enqueue onto, so
// CastBallot calls this in-process, synchronously, fire-and-forget: a
// resolver failure must not undo the already-committed ballot (see
// CastBallot below). It returns the citizen ids that have an active
// delegation to citizenID in domainID -- CastBallot uses the count to
// weight the ballot so a delegate's vote actually counts once for each
// citizen who delegated to them, per DP-041's "ballot also applies to
// delegators" requirement. See remote.go for the real HTTP-calling
// implementation used when DELEGATION_SERVICE_URL is configured.
type DelegationResolver interface {
	ResolveDelegators(citizenID, domainID string) ([]string, error)
}

type noopDelegationResolver struct{}

func (noopDelegationResolver) ResolveDelegators(string, string) ([]string, error) { return nil, nil }

// AuditEmitter models the DP-036 audit-service emission on certification;
// audit-service isn't implemented here, so this is a no-op by default.
type AuditEmitter interface {
	Emit(eventType, payload string) error
}

// No ReputationEmitter seam is modeled here, unlike DelegationResolver and
// AuditEmitter above: SRV-014 lists voting-service among reputation-
// service's event sources, but ballot secrecy (no citizen_id is ever
// stored on a Ballot -- see CastBallot/store.go) means this service has no
// legitimate per-citizen signal to emit in the first place, not merely an
// unwired one. A real "accurate_prediction" factor would have to be
// computed elsewhere, correlating an anonymous tally result against
// deliberation-service's preference declarations without re-identifying
// any individual ballot.

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(string, string) error { return nil }

type Service struct {
	store      *store
	delegation DelegationResolver
	audit      AuditEmitter
}

func NewService(delegation DelegationResolver, audit AuditEmitter) *Service {
	if delegation == nil {
		delegation = noopDelegationResolver{}
	}
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	return &Service{store: newStore(), delegation: delegation, audit: audit}
}

type CreateSessionInput struct {
	ProposalID       string
	JurisdictionID   string
	Method           VoteMethod
	ThresholdRule    ThresholdRule
	MinParticipation float64
	CoolingOffUntil  time.Time
	OpensAt          time.Time
	ClosesAt         time.Time
}

type AddOptionInput struct {
	ProposalID  string
	Label       string
	Description string
}

// IssuedToken carries a citizen's raw token secret. It exists in plaintext
// only here, at issuance time -- a real deployment would deliver it to the
// citizen out-of-band (signed link, QR code, etc.), never return it from
// this admin/internal call.
type IssuedToken struct {
	CitizenID   string `json:"citizen_id"`
	TokenSecret string `json:"token_secret"`
}

func (s *Service) CreateSession(input CreateSessionInput) (*VoteSession, error) {
	if strings.TrimSpace(input.ProposalID) == "" || strings.TrimSpace(input.JurisdictionID) == "" {
		return nil, fmt.Errorf("%w: proposal_id and jurisdiction_id are required", ErrValidation)
	}
	if !input.Method.valid() {
		return nil, fmt.Errorf("%w: invalid method %q", ErrValidation, input.Method)
	}
	if !input.ThresholdRule.valid() {
		return nil, fmt.Errorf("%w: invalid threshold_rule %q", ErrValidation, input.ThresholdRule)
	}
	if input.MinParticipation <= 0 || input.MinParticipation > 1 {
		return nil, fmt.Errorf("%w: min_participation must be in (0,1]", ErrValidation)
	}
	if !input.ClosesAt.After(input.OpensAt) {
		return nil, fmt.Errorf("%w: closes_at must be after opens_at", ErrValidation)
	}
	if input.OpensAt.Before(input.CoolingOffUntil) {
		return nil, fmt.Errorf("%w: opens_at must be at or after cooling_off_until", ErrValidation)
	}

	key, err := generateAESKey()
	if err != nil {
		return nil, fmt.Errorf("generate session key: %w", err)
	}
	shares, err := shamirSplit(key, shamirShares, shamirThreshold)
	if err != nil {
		return nil, fmt.Errorf("split session key: %w", err)
	}
	// key deliberately goes out of scope here unstored -- only shares persist.

	session := &VoteSession{
		ID:               newID(),
		ProposalID:       input.ProposalID,
		JurisdictionID:   input.JurisdictionID,
		Method:           input.Method,
		ThresholdRule:    input.ThresholdRule,
		MinParticipation: input.MinParticipation,
		CoolingOffUntil:  input.CoolingOffUntil,
		OpensAt:          input.OpensAt,
		ClosesAt:         input.ClosesAt,
		Status:           StatusScheduled,
		CreatedAt:        time.Now().UTC(),
	}
	s.store.CreateSession(session, shares)
	return session, nil
}

func (s *Service) AddOption(sessionID string, input AddOptionInput) (*VoteOption, error) {
	if strings.TrimSpace(input.Label) == "" {
		return nil, fmt.Errorf("%w: label is required", ErrValidation)
	}
	opt := &VoteOption{
		ID:            newID(),
		VoteSessionID: sessionID,
		ProposalID:    input.ProposalID,
		Label:         input.Label,
		Description:   input.Description,
	}
	if err := s.store.AddOption(sessionID, opt); err != nil {
		return nil, err
	}
	return opt, nil
}

func (s *Service) ListOptions(sessionID string) ([]*VoteOption, error) {
	return s.store.ListOptions(sessionID)
}

func (s *Service) GetSession(sessionID string) (*VoteSession, error) {
	return s.store.GetSession(sessionID)
}

// TransitionOpen models DP-046: opens sessions whose scheduled window has
// arrived. In a real deployment this runs as a cron sweep every 15 min.
func (s *Service) TransitionOpen(sessionID string, now time.Time) error {
	return s.store.TransitionOpen(sessionID, now)
}

// IssueEligibilityTokens models DP-025, triggered right after a session
// opens. Idempotent per citizen; only newly-issued citizens are returned.
func (s *Service) IssueEligibilityTokens(sessionID string, citizenIDs []string) ([]IssuedToken, error) {
	if _, err := s.store.GetSession(sessionID); err != nil {
		return nil, err
	}
	issued := make([]IssuedToken, 0, len(citizenIDs))
	for _, citizenID := range citizenIDs {
		citizenID = strings.TrimSpace(citizenID)
		if citizenID == "" {
			continue
		}
		secret, err := randomHex(24)
		if err != nil {
			return nil, fmt.Errorf("generate token secret: %w", err)
		}
		created, err := s.store.IssueToken(sessionID, citizenID, sha256Hex(secret), time.Now().UTC())
		if err != nil {
			return nil, err
		}
		if created {
			issued = append(issued, IssuedToken{CitizenID: citizenID, TokenSecret: secret})
		}
	}
	return issued, nil
}

// CastBallot implements DP-016 as one atomic store operation (see
// store.CastBallot), then fires DP-041 delegation resolution.
func (s *Service) CastBallot(sessionID, tokenSecret, choicePlaintext string, now time.Time) (*Ballot, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("%w: session_id is required", ErrValidation)
	}
	if strings.TrimSpace(tokenSecret) == "" {
		return nil, fmt.Errorf("%w: token_secret is required", ErrValidation)
	}

	ballot, citizenID, proposalID, err := s.store.CastBallot(sessionID, tokenSecret, choicePlaintext, now)
	if err != nil {
		return nil, err
	}

	// Fire-and-forget: a resolver failure must not undo the already-committed
	// ballot. The proposal stands in for "domain" until proposal-service's
	// domain model is available here. Every resolved delegator raises this
	// ballot's weight by one, so CloseSession's tally counts it once for the
	// citizen and once more for each citizen who delegated to them.
	if delegatorIDs, err := s.delegation.ResolveDelegators(citizenID, proposalID); err == nil && len(delegatorIDs) > 0 {
		weight := 1 + len(delegatorIDs)
		if err := s.store.SetBallotWeight(sessionID, ballot.ID, weight); err == nil {
			ballot.Weight = weight
		}
	}

	return ballot, nil
}

// VerifyBallotInclusion implements DP-017: read-only, and must never leak
// encrypted_choice or any citizen-identifying data.
func (s *Service) VerifyBallotInclusion(sessionID, verificationCode string) (bool, error) {
	return s.store.HasBallotWithCode(sessionID, verificationCode)
}

// CloseSession chains DP-047 (close trigger) + DP-026 (tally) + DP-027
// (certification) synchronously, since no message queue exists yet in this
// codebase to decouple them.
func (s *Service) CloseSession(sessionID string, now time.Time) (*VoteSession, error) {
	session, ballots, issuedCount, err := s.store.PrepareClose(sessionID, now)
	if err != nil {
		return nil, err
	}

	shares, err := s.store.GetKeyShares(sessionID)
	if err != nil {
		return nil, err
	}
	key, err := shamirCombine(shares[:shamirThreshold])
	if err != nil {
		return nil, fmt.Errorf("reconstruct session key: %w", err)
	}

	optionIDs, err := s.optionIDs(sessionID)
	if err != nil {
		return nil, err
	}

	// A weight-N ballot is fed into the tally as N identical entries: every
	// method here (approval counts, preference-score averages, ranked-choice
	// IRV counts, comparative pairwise counts) is a linear aggregate over
	// the ballot multiset, so replaying a ballot N times is mathematically
	// equivalent to counting it once with weight N -- no per-method weight
	// parameter is needed. See Ballot.Weight and DelegationResolver.
	plainChoices := make([]string, 0, len(ballots))
	for _, b := range ballots {
		plain, err := decryptAESGCM(key, b.Nonce, b.EncryptedChoice)
		if err != nil {
			return nil, fmt.Errorf("decrypt ballot %s: %w", b.ID, err)
		}
		weight := b.Weight
		if weight < 1 {
			weight = 1
		}
		for i := 0; i < weight; i++ {
			plainChoices = append(plainChoices, string(plain))
		}
	}

	outcome := computeMethodOutcome(session.Method, optionIDs, plainChoices)
	winner := outcome.WinnerOptionID
	if session.ThresholdRule == ThresholdSupermajority && (winner == nil || outcome.WinnerShare < 2.0/3.0) {
		winner = nil
	}

	participationRate := 0.0
	if issuedCount > 0 {
		participationRate = float64(len(ballots)) / float64(issuedCount)
	}
	quorumMet := participationRate >= session.MinParticipation

	tally := &TallyResult{
		SessionID:         sessionID,
		Method:            session.Method,
		Counts:            outcome.Counts,
		WinnerOptionID:    winner,
		TotalBallots:      len(ballots),
		ParticipationRate: participationRate,
		QuorumMet:         quorumMet,
	}
	if quorumMet {
		certifiedAt := now.UTC()
		tally.CertifiedAt = &certifiedAt
	}

	updated, err := s.store.RecordTally(sessionID, tally, quorumMet)
	if err != nil {
		return nil, err
	}

	if quorumMet {
		// "vote_certified" matches audit-service's ActionType enum exactly
		// (TBL-034) so httpAuditEmitter can pass it straight through as
		// action_type with no translation.
		_ = s.audit.Emit("vote_certified", sessionID)
	}

	return updated, nil
}

func (s *Service) optionIDs(sessionID string) ([]string, error) {
	opts, err := s.store.ListOptions(sessionID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(opts))
	for i, o := range opts {
		ids[i] = o.ID
	}
	return ids, nil
}

func (s *Service) GetTally(sessionID string) (*TallyResult, error) {
	return s.store.GetTally(sessionID)
}
