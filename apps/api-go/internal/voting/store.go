package voting

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// MemoryStore is the in-memory Store implementation (ARCH-009): all methods
// are safe for concurrent use, and DP-016's three-step cast executes
// atomically under a single write lock. Memory methods return nil errors;
// the error exists for signature parity with PGStore, where every query can
// fail (connection loss must surface as 500s, never zero values).
type MemoryStore struct {
	mu sync.RWMutex

	sessions map[string]*VoteSession
	options  map[string]*VoteOption
	// optionsBySession indexes option ids per session.
	optionsBySession map[string][]string
	tokens           map[string]*EligibilityToken
	// tokenBySessionCitizen enforces the (vote_session_id, citizen_id)
	// uniqueness that makes DP-025 idempotent (SRV-008 key rules).
	tokenBySessionCitizen map[string]string
	tokensBySession       map[string][]string
	ballots               map[string]*Ballot
	ballotByVerification  map[string]string
}

func NewStore() *MemoryStore {
	return &MemoryStore{
		sessions:              make(map[string]*VoteSession),
		options:               make(map[string]*VoteOption),
		optionsBySession:      make(map[string][]string),
		tokens:                make(map[string]*EligibilityToken),
		tokenBySessionCitizen: make(map[string]string),
		tokensBySession:       make(map[string][]string),
		ballots:               make(map[string]*Ballot),
		ballotByVerification:  make(map[string]string),
	}
}

func copySession(s *VoteSession) *VoteSession {
	c := *s
	return &c
}

// CreateSession inserts a scheduled session (DP-046/DP-057 drive it later).
func (st *MemoryStore) CreateSession(s *VoteSession) (*VoteSession, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s.ID = newID()
	s.Status = SessionScheduled
	s.CreatedAt = time.Now().UTC()
	st.sessions[s.ID] = s
	return copySession(s), nil
}

func (st *MemoryStore) GetSession(id string) (*VoteSession, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return copySession(s), nil
}

func (st *MemoryStore) ListSessions() ([]*VoteSession, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := make([]*VoteSession, 0, len(st.sessions))
	for _, s := range st.sessions {
		out = append(out, copySession(s))
	}
	return out, nil
}

// UpdateSessionStatus transitions status; callers enforce the state machine.
func (st *MemoryStore) UpdateSessionStatus(id, status string) (*VoteSession, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	s.Status = status
	return copySession(s), nil
}

func (st *MemoryStore) SetTally(id string, tally *TallyResult) (*VoteSession, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	s.TallyResult = tally
	return copySession(s), nil
}

func (st *MemoryStore) AddOption(o *VoteOption) (*VoteOption, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	o.ID = newID()
	st.options[o.ID] = o
	st.optionsBySession[o.SessionID] = append(st.optionsBySession[o.SessionID], o.ID)
	c := *o
	return &c, nil
}

func (st *MemoryStore) ListOptions(sessionID string) ([]*VoteOption, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	ids := st.optionsBySession[sessionID]
	out := make([]*VoteOption, 0, len(ids))
	for _, id := range ids {
		c := *st.options[id]
		out = append(out, &c)
	}
	return out, nil
}

// IssueToken inserts one eligibility token; existing (session, citizen)
// rows are returned unchanged (DP-025 idempotency) and never carry the raw
// blind. Fresh rows carry it exactly once on the returned copy: the raw goes
// to the citizen out of band while only its hash is stored, so the stored
// row cannot be joined to a future ballot (ADR-002).
func (st *MemoryStore) IssueToken(sessionID, citizenID string) (*EligibilityToken, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	key := sessionID + "\x00" + citizenID
	if id, ok := st.tokenBySessionCitizen[key]; ok {
		c := *st.tokens[id]
		c.TokenBlind = ""
		return &c, nil
	}
	raw := newToken()
	sum := sha256.Sum256([]byte(raw))
	t := &EligibilityToken{
		ID:               newID(),
		SessionID:        sessionID,
		CitizenID:        citizenID,
		BlindedTokenHash: hex.EncodeToString(sum[:]),
		IssuedAt:         time.Now().UTC(),
	}
	st.tokens[t.ID] = t
	st.tokenBySessionCitizen[key] = t.ID
	st.tokensBySession[sessionID] = append(st.tokensBySession[sessionID], t.ID)
	c := *t
	c.TokenBlind = raw
	return &c, nil
}

func (st *MemoryStore) GetToken(id string) (*EligibilityToken, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	t, ok := st.tokens[id]
	if !ok {
		return nil, ErrNotFound
	}
	c := *t
	return &c, nil
}

func (st *MemoryStore) CountTokens(sessionID string) (int, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return len(st.tokensBySession[sessionID]), nil
}

// CastBallot executes DP-016 atomically: verify token unused and bound to
// the session, write the ballot (no citizen_id), mark token used.
func (st *MemoryStore) CastBallot(sessionID, tokenID, tokenBlind, encryptedChoice string) (*Ballot, *EligibilityToken, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, ok := st.tokens[tokenID]
	if !ok || t.SessionID != sessionID {
		return nil, nil, ErrNotFound
	}
	if t.Used {
		return nil, nil, ErrConflict
	}
	sum := sha256.Sum256([]byte(tokenBlind))
	if hex.EncodeToString(sum[:]) != t.BlindedTokenHash {
		return nil, nil, ErrInvalid
	}
	b := &Ballot{
		ID:               newID(),
		SessionID:        sessionID,
		TokenBlind:       tokenBlind,
		EncryptedChoice:  encryptedChoice,
		VerificationCode: newToken(),
		CastAt:           time.Now().UTC(),
	}
	st.ballots[b.ID] = b
	st.ballotByVerification[b.VerificationCode] = b.ID
	t.Used = true
	bc := *b
	tc := *t
	return &bc, &tc, nil
}

// FindBallotByVerification implements DP-017 lookup.
func (st *MemoryStore) FindBallotByVerification(code string) (*Ballot, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	id, ok := st.ballotByVerification[code]
	if !ok {
		return nil, ErrNotFound
	}
	b := *st.ballots[id]
	return &b, nil
}

// BallotsForSession returns copies for tallying (DP-026).
func (st *MemoryStore) BallotsForSession(sessionID string) ([]*Ballot, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*Ballot
	for _, b := range st.ballots {
		if b.SessionID == sessionID {
			c := *b
			out = append(out, &c)
		}
	}
	return out, nil
}
