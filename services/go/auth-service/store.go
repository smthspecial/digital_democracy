package main

import (
	"sync"
	"time"
)

// store is an in-memory, thread-safe repository for sessions, MFA factors and
// auth events. A single mutex guards every map/slice below; a real deployment
// swaps this out for a persistence layer behind the same method set.
type store struct {
	mu sync.Mutex

	sessions     map[string]Session
	accessIndex  map[string]string // access_token_hash -> session id
	refreshIndex map[string]string // refresh_token_hash -> session id
	superseded   map[string]string // rotated-away refresh_token_hash -> session id, for reuse detection

	factors map[string]MFAFactor

	events []AuthEvent

	failures map[string][]time.Time // citizen_id -> stepup failure timestamps
}

func newStore() *store {
	return &store{
		sessions:     make(map[string]Session),
		accessIndex:  make(map[string]string),
		refreshIndex: make(map[string]string),
		superseded:   make(map[string]string),
		factors:      make(map[string]MFAFactor),
		failures:     make(map[string][]time.Time),
	}
}

func (s *store) CreateSession(sess Session) Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess.ID == "" {
		sess.ID = newID()
	}
	s.indexSessionLocked(sess)
	return sess
}

// SaveSession upserts a session, keeping the access/refresh hash indices in
// sync. When a refresh_token_hash changes, the old hash is moved into the
// superseded index rather than dropped, so a later replay of it can be
// detected as token reuse.
func (s *store) SaveSession(sess Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.sessions[sess.ID]; ok {
		if old.AccessTokenHash != "" && old.AccessTokenHash != sess.AccessTokenHash {
			delete(s.accessIndex, old.AccessTokenHash)
		}
		if old.RefreshTokenHash != "" && old.RefreshTokenHash != sess.RefreshTokenHash {
			delete(s.refreshIndex, old.RefreshTokenHash)
			s.superseded[old.RefreshTokenHash] = sess.ID
		}
	}
	s.indexSessionLocked(sess)
}

func (s *store) indexSessionLocked(sess Session) {
	s.sessions[sess.ID] = sess
	if sess.AccessTokenHash != "" {
		s.accessIndex[sess.AccessTokenHash] = sess.ID
	}
	if sess.RefreshTokenHash != "" {
		s.refreshIndex[sess.RefreshTokenHash] = sess.ID
	}
}

func (s *store) GetSession(id string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *store) GetSessionByAccessHash(hash string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.accessIndex[hash]
	if !ok {
		return Session{}, false
	}
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *store) GetSessionByRefreshHash(hash string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.refreshIndex[hash]
	if !ok {
		return Session{}, false
	}
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *store) RefreshHashSuperseded(hash string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.superseded[hash]
	return id, ok
}

func (s *store) SessionsByCitizen(citizenID string) []Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Session
	for _, sess := range s.sessions {
		if sess.CitizenID == citizenID {
			out = append(out, sess)
		}
	}
	return out
}

// PurgeSessions deletes every session for which shouldPurge returns true and
// reports how many were removed.
func (s *store) PurgeSessions(shouldPurge func(Session) bool) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, sess := range s.sessions {
		if !shouldPurge(sess) {
			continue
		}
		delete(s.sessions, id)
		if sess.AccessTokenHash != "" {
			delete(s.accessIndex, sess.AccessTokenHash)
		}
		if sess.RefreshTokenHash != "" {
			delete(s.refreshIndex, sess.RefreshTokenHash)
		}
		n++
	}
	return n
}

func (s *store) CreateFactor(f MFAFactor) MFAFactor {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f.ID == "" {
		f.ID = newID()
	}
	s.factors[f.ID] = f
	return f
}

func (s *store) SaveFactor(f MFAFactor) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.factors[f.ID] = f
}

func (s *store) GetFactor(id string) (MFAFactor, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.factors[id]
	return f, ok
}

// ActiveFactor returns the citizen's active factor of the given type, if any.
// A citizen is assumed to hold at most one active factor per type.
func (s *store) ActiveFactor(citizenID string, ft FactorType) (MFAFactor, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.factors {
		if f.CitizenID == citizenID && f.FactorType == ft && f.Status == FactorActive {
			return f, true
		}
	}
	return MFAFactor{}, false
}

func (s *store) ActiveFactorTypes(citizenID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Non-nil so a citizen with no enrolled factors serializes to `[]` on
	// the wire (ARCH-010 HP-1), not `null`.
	out := []string{}
	for _, f := range s.factors {
		if f.CitizenID == citizenID && f.Status == FactorActive {
			out = append(out, string(f.FactorType))
		}
	}
	return out
}

func (s *store) AppendEvent(e AuthEvent) AuthEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.ID == "" {
		e.ID = newID()
	}
	s.events = append(s.events, e)
	return e
}

func (s *store) Events() []AuthEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AuthEvent, len(s.events))
	copy(out, s.events)
	return out
}

// RecordFailure appends a failure timestamp for the citizen, prunes entries
// older than window relative to at, and returns the resulting count.
func (s *store) RecordFailure(citizenID string, at time.Time, window time.Duration) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	timestamps := append(s.failures[citizenID], at)
	cutoff := at.Add(-window)
	kept := timestamps[:0]
	for _, ts := range timestamps {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	s.failures[citizenID] = kept
	return len(kept)
}

func (s *store) ResetFailures(citizenID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.failures, citizenID)
}
