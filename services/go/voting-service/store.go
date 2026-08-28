package main

import (
	"sync"
	"time"
)

// sessionTokens indexes one session's eligibility tokens two ways so both
// idempotent-issuance (by citizen) and cast-time lookup (by blinded hash)
// are O(1); both maps point at the same *EligibilityToken rows.
type sessionTokens struct {
	byCitizen map[string]*EligibilityToken
	byHash    map[string]*EligibilityToken
}

// store is the in-memory, thread-safe repository backing the service. A
// single mutex guards every map so compound operations (e.g. CastBallot)
// can be made atomic by holding one lock for their whole duration.
type store struct {
	mu sync.Mutex

	sessions map[string]*VoteSession
	options  map[string][]*VoteOption
	tokens   map[string]*sessionTokens
	ballots  map[string][]*Ballot
	verify   map[string]map[string]bool // sessionID -> verification code -> exists

	// keyShares models the N independent key-holder shares of each
	// session's AES key (see shamir.go). The raw key itself is never
	// stored here as a field -- only shares, per ADR-019's threshold
	// cryptography requirement.
	keyShares map[string][]Share

	tallies map[string]*TallyResult
}

func newStore() *store {
	return &store{
		sessions:  make(map[string]*VoteSession),
		options:   make(map[string][]*VoteOption),
		tokens:    make(map[string]*sessionTokens),
		ballots:   make(map[string][]*Ballot),
		verify:    make(map[string]map[string]bool),
		keyShares: make(map[string][]Share),
		tallies:   make(map[string]*TallyResult),
	}
}

func cloneSession(s *VoteSession) *VoteSession {
	cp := *s
	return &cp
}

func (st *store) CreateSession(session *VoteSession, shares []Share) {
	st.mu.Lock()
	defer st.mu.Unlock()

	st.sessions[session.ID] = cloneSession(session)
	st.keyShares[session.ID] = shares
	st.tokens[session.ID] = &sessionTokens{
		byCitizen: make(map[string]*EligibilityToken),
		byHash:    make(map[string]*EligibilityToken),
	}
	st.verify[session.ID] = make(map[string]bool)
}

func (st *store) GetSession(sessionID string) (*VoteSession, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	s, ok := st.sessions[sessionID]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return cloneSession(s), nil
}

func (st *store) AddOption(sessionID string, opt *VoteOption) error {
	st.mu.Lock()
	defer st.mu.Unlock()

	s, ok := st.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}
	if s.Status != StatusScheduled {
		return ErrSessionNotScheduled
	}
	st.options[sessionID] = append(st.options[sessionID], opt)
	return nil
}

func (st *store) ListOptions(sessionID string) ([]*VoteOption, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	if _, ok := st.sessions[sessionID]; !ok {
		return nil, ErrSessionNotFound
	}
	opts := st.options[sessionID]
	out := make([]*VoteOption, len(opts))
	copy(out, opts)
	return out, nil
}

func (st *store) TransitionOpen(sessionID string, now time.Time) error {
	st.mu.Lock()
	defer st.mu.Unlock()

	s, ok := st.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}
	if s.Status != StatusScheduled {
		return ErrSessionNotScheduled
	}
	if s.CoolingOffUntil.After(now) || s.OpensAt.After(now) {
		return ErrOpenPreconditionFailed
	}
	s.Status = StatusOpen
	return nil
}

// IssueToken is idempotent per (sessionID, citizenID): if the citizen
// already has a token it is a silent no-op (created=false), matching
// DP-025's at-least-once delivery guarantee over a unique constraint.
func (st *store) IssueToken(sessionID, citizenID, blindedHash string, issuedAt time.Time) (created bool, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	if _, ok := st.sessions[sessionID]; !ok {
		return false, ErrSessionNotFound
	}
	toks := st.tokens[sessionID]
	if _, exists := toks.byCitizen[citizenID]; exists {
		return false, nil
	}
	tok := &EligibilityToken{
		ID:               newID(),
		VoteSessionID:    sessionID,
		CitizenID:        citizenID,
		BlindedTokenHash: blindedHash,
		IssuedAt:         issuedAt,
		Used:             false,
	}
	toks.byCitizen[citizenID] = tok
	toks.byHash[blindedHash] = tok
	return true, nil
}

func (st *store) CountIssuedTokens(sessionID string) (int, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	toks, ok := st.tokens[sessionID]
	if !ok {
		return 0, ErrSessionNotFound
	}
	return len(toks.byCitizen), nil
}

// CastBallot performs DP-016 as a single atomic operation: token lookup,
// key reconstruction, encryption, ballot insertion, and marking the token
// used all happen under one lock acquisition, so no observer can ever see
// a used token with no corresponding ballot or vice versa.
func (st *store) CastBallot(sessionID, tokenSecret, choicePlaintext string, now time.Time) (ballot *Ballot, citizenID string, proposalID string, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	session, ok := st.sessions[sessionID]
	if !ok {
		return nil, "", "", ErrSessionNotFound
	}
	if session.Status != StatusOpen {
		return nil, "", "", ErrSessionNotOpen
	}

	hash := sha256Hex(tokenSecret)
	tok, ok := st.tokens[sessionID].byHash[hash]
	if !ok {
		return nil, "", "", ErrTokenNotFound
	}
	if tok.Used {
		return nil, "", "", ErrTokenUsed
	}

	key, err := shamirCombine(st.keyShares[sessionID][:shamirThreshold])
	if err != nil {
		return nil, "", "", err
	}
	ciphertext, nonce, err := encryptAESGCM(key, []byte(choicePlaintext))
	if err != nil {
		return nil, "", "", err
	}

	tokenBlind, err := randomHex(16)
	if err != nil {
		return nil, "", "", err
	}
	code, err := st.uniqueVerificationCodeLocked(sessionID)
	if err != nil {
		return nil, "", "", err
	}

	b := &Ballot{
		ID:               newID(),
		VoteSessionID:    sessionID,
		TokenBlind:       tokenBlind,
		EncryptedChoice:  ciphertext,
		Nonce:            nonce,
		VerificationCode: code,
		CastAt:           now,
		Weight:           1,
	}
	st.ballots[sessionID] = append(st.ballots[sessionID], b)
	st.verify[sessionID][code] = true
	tok.Used = true

	return b, tok.CitizenID, session.ProposalID, nil
}

// SetBallotWeight updates an already-cast ballot's tally weight (see
// Ballot.Weight). Called after CastBallot returns, once delegation
// resolution completes, so a resolver failure never blocks the ballot cast
// itself -- it just leaves the weight at its default of 1.
func (st *store) SetBallotWeight(sessionID, ballotID string, weight int) error {
	st.mu.Lock()
	defer st.mu.Unlock()

	for _, b := range st.ballots[sessionID] {
		if b.ID == ballotID {
			b.Weight = weight
			return nil
		}
	}
	return ErrBallotNotFound
}

// uniqueVerificationCodeLocked must be called with st.mu already held.
func (st *store) uniqueVerificationCodeLocked(sessionID string) (string, error) {
	for {
		code, err := randomHex(4)
		if err != nil {
			return "", err
		}
		if !st.verify[sessionID][code] {
			return code, nil
		}
	}
}

func (st *store) HasBallotWithCode(sessionID, code string) (bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	codes, ok := st.verify[sessionID]
	if !ok {
		return false, ErrSessionNotFound
	}
	return codes[code], nil
}

// PrepareClose validates and applies the open->closed transition, then
// returns a snapshot (copied ballots slice, issued token count) safe to
// read without further locking -- ballots and tokens for this session
// cannot change again once status leaves "open".
func (st *store) PrepareClose(sessionID string, now time.Time) (session *VoteSession, ballots []*Ballot, issuedCount int, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	s, ok := st.sessions[sessionID]
	if !ok {
		return nil, nil, 0, ErrSessionNotFound
	}
	if s.Status != StatusOpen {
		return nil, nil, 0, ErrSessionNotOpen
	}
	if s.ClosesAt.After(now) {
		return nil, nil, 0, ErrCloseNotEligible
	}
	s.Status = StatusClosed

	bs := st.ballots[sessionID]
	out := make([]*Ballot, len(bs))
	copy(out, bs)

	return cloneSession(s), out, len(st.tokens[sessionID].byCitizen), nil
}

func (st *store) GetKeyShares(sessionID string) ([]Share, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	shares, ok := st.keyShares[sessionID]
	if !ok {
		return nil, ErrSessionNotFound
	}
	out := make([]Share, len(shares))
	copy(out, shares)
	return out, nil
}

// RecordTally stores the computed tally and, if certify is true, promotes
// the session to status=certified.
func (st *store) RecordTally(sessionID string, tally *TallyResult, certify bool) (*VoteSession, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	s, ok := st.sessions[sessionID]
	if !ok {
		return nil, ErrSessionNotFound
	}
	if certify {
		s.Status = StatusCertified
	}
	st.tallies[sessionID] = tally
	return cloneSession(s), nil
}

func (st *store) GetTally(sessionID string) (*TallyResult, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	if _, ok := st.sessions[sessionID]; !ok {
		return nil, ErrSessionNotFound
	}
	t, ok := st.tallies[sessionID]
	if !ok {
		return nil, ErrTallyNotAvailable
	}
	return t, nil
}
