package auth

import (
	"sync"
	"time"
)

// MemoryStore is the in-memory Store implementation (ARCH-009), safe for
// concurrent use. Token hashes are the only lookup keys: plaintext tokens
// never touch the store. Consumed refresh hashes are retained in
// usedRefreshHashes so replays are detected as token_reuse anomalies (DP-066)
// instead of silent 401s. Methods return nil errors; the error exists for
// parity with PGStore.
type MemoryStore struct {
	mu sync.RWMutex

	sessions          map[string]*Session
	sessionByAccess   map[string]string
	sessionByRefresh  map[string]string
	usedRefreshHashes map[string]bool

	factors map[string]*MfaFactor
	// factorsByCitizen indexes factor ids per citizen.
	factorsByCitizen map[string][]string

	events []*AuthEvent
	// mfaFailures tracks recent failure times per session for brute-force
	// detection (DP-061 → DP-066).
	mfaFailures map[string][]time.Time
}

func NewStore() *MemoryStore {
	return &MemoryStore{
		sessions:          make(map[string]*Session),
		sessionByAccess:   make(map[string]string),
		sessionByRefresh:  make(map[string]string),
		usedRefreshHashes: make(map[string]bool),
		factors:           make(map[string]*MfaFactor),
		factorsByCitizen:  make(map[string][]string),
		mfaFailures:       make(map[string][]time.Time),
	}
}

func (st *MemoryStore) InsertSession(s *Session) (*Session, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.sessions[s.ID] = s
	st.sessionByAccess[s.AccessTokenHash] = s.ID
	st.sessionByRefresh[s.RefreshTokenHash] = s.ID
	c := *s
	return &c, nil
}

func (st *MemoryStore) GetSession(id string) (*Session, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	c := *s
	return &c, nil
}

func (st *MemoryStore) FindByAccess(hash string) (*Session, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	id, ok := st.sessionByAccess[hash]
	if !ok {
		return nil, ErrNotFound
	}
	c := *st.sessions[id]
	return &c, nil
}

func (st *MemoryStore) FindByRefresh(hash string) (*Session, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	id, ok := st.sessionByRefresh[hash]
	if !ok {
		return nil, ErrNotFound
	}
	c := *st.sessions[id]
	return &c, nil
}

// RefreshReuse reports whether a refresh hash was already rotated (DP-066
// token_reuse signal).
func (st *MemoryStore) RefreshReuse(hash string) bool {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.usedRefreshHashes[hash]
}

// RotateRefresh swaps access/refresh hashes atomically and retires the old
// refresh hash into the reuse set.
func (st *MemoryStore) RotateRefresh(id, newAccessHash, newRefreshHash string, accessExp, refreshedAt time.Time) (*Session, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	delete(st.sessionByAccess, s.AccessTokenHash)
	delete(st.sessionByRefresh, s.RefreshTokenHash)
	st.usedRefreshHashes[s.RefreshTokenHash] = true
	s.AccessTokenHash = newAccessHash
	s.RefreshTokenHash = newRefreshHash
	s.AccessExpiresAt = accessExp
	s.LastRefreshAt = refreshedAt
	st.sessionByAccess[newAccessHash] = id
	st.sessionByRefresh[newRefreshHash] = id
	c := *s
	return &c, nil
}

func (st *MemoryStore) SetStatus(id, status string) (*Session, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	s.Status = status
	c := *s
	return &c, nil
}

func (st *MemoryStore) SetTier(id, tier string, mfaAt time.Time) (*Session, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	s.AssuranceTier = tier
	s.LastMFAAt = mfaAt
	c := *s
	return &c, nil
}

// RotateAccess mints a fresh access hash (step-up flow, DP-061): the
// refresh token is untouched — rotation happens on the refresh flow only.
func (st *MemoryStore) RotateAccess(id, newAccessHash string, accessExp time.Time) (*Session, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	delete(st.sessionByAccess, s.AccessTokenHash)
	s.AccessTokenHash = newAccessHash
	s.AccessExpiresAt = accessExp
	st.sessionByAccess[newAccessHash] = id
	c := *s
	return &c, nil
}

// RevokeAll force-revokes every session of a citizen (DP-042 linkage,
// multi-approval governance decision). Revoked rows stay for audit.
func (st *MemoryStore) RevokeAll(citizenID string, now time.Time) (int, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	n := 0
	for _, s := range st.sessions {
		if s.CitizenID == citizenID && s.Status != SessionRevoked {
			s.Status = SessionRevoked
			n++
		}
		_ = now
	}
	return n, nil
}

func (st *MemoryStore) SessionsOf(citizenID string) ([]*Session, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*Session
	for _, s := range st.sessions {
		if s.CitizenID == citizenID {
			c := *s
			out = append(out, &c)
		}
	}
	return out, nil
}

// PurgeExpired deletes naturally-expired, never-revoked sessions past the
// retention grace window (DP-067). Returns the removed count.
func (st *MemoryStore) PurgeExpired(now time.Time) (int, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	n := 0
	for id, s := range st.sessions {
		if s.Status == SessionRevoked {
			continue
		}
		if now.After(s.ExpiresAt.Add(PurgeGrace)) {
			delete(st.sessionByAccess, s.AccessTokenHash)
			delete(st.sessionByRefresh, s.RefreshTokenHash)
			delete(st.sessions, id)
			n++
		}
	}
	return n, nil
}

func (st *MemoryStore) InsertFactor(f *MfaFactor) (*MfaFactor, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	f.ID = newID()
	f.EnrolledAt = time.Now().UTC()
	st.factors[f.ID] = f
	st.factorsByCitizen[f.CitizenID] = append(st.factorsByCitizen[f.CitizenID], f.ID)
	c := *f
	return &c, nil
}

func (st *MemoryStore) ActiveFactors(citizenID string) ([]*MfaFactor, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*MfaFactor
	for _, id := range st.factorsByCitizen[citizenID] {
		if f := st.factors[id]; f.Status == FactorActive {
			c := *f
			out = append(out, &c)
		}
	}
	return out, nil
}

func (st *MemoryStore) TouchFactor(id string, now time.Time) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if f, ok := st.factors[id]; ok {
		f.LastUsedAt = now
	}
	return nil
}

func (st *MemoryStore) AppendEvent(e *AuthEvent) (*AuthEvent, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	e.ID = newID()
	e.CreatedAt = time.Now().UTC()
	st.events = append(st.events, e)
	c := *e
	return &c, nil
}

func (st *MemoryStore) ListEvents(citizenID string) ([]*AuthEvent, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*AuthEvent
	for _, e := range st.events {
		if citizenID == "" || e.CitizenID == citizenID {
			c := *e
			out = append(out, &c)
		}
	}
	return out, nil
}

// RecordMFAFailure tracks failures and reports whether the brute-force
// threshold tripped (DP-061 → DP-066, reason=mfa_brute_force). The window
// lives in process memory on both backends (best-effort across restarts).
func (st *MemoryStore) RecordMFAFailure(sessionID string, now time.Time) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	cutoff := now.Add(-MFAFailureWindow)
	kept := st.mfaFailures[sessionID][:0]
	for _, t := range st.mfaFailures[sessionID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	st.mfaFailures[sessionID] = kept
	return len(kept) >= MaxMFAFailures
}
