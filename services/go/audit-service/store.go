package main

import (
	"sync"
	"time"
)

// Store is the in-memory, thread-safe repository backing this service. The
// audit_log is truly append-only: there is no update or delete method for
// it anywhere in this type, on purpose.
type Store struct {
	mu sync.RWMutex

	entries []AuditLogEntry
	byID    map[string]AuditLogEntry
	pending map[string]AuditLogEntry // buffered entries, keyed by their claimed (not-yet-current) prev_hash
	idem    map[string]string        // idempotency key -> entry id

	rights  []ConstitutionalRight
	reviews []ConstitutionalReview

	// signingKey is generated once per process and held only in memory; a
	// real deployment would use an asymmetric key or KMS instead (see
	// computeSignature).
	signingKey []byte
}

func NewStore() *Store {
	return &Store{
		byID:       make(map[string]AuditLogEntry),
		pending:    make(map[string]AuditLogEntry),
		idem:       make(map[string]string),
		signingKey: generateSigningKey(),
	}
}

// Append links a new entry to the current chain tip. Because it always
// links to the tip under the store's own lock, it can never be buffered --
// see linkEntry for the lower-level primitive that handles out-of-order
// arrivals.
func (s *Store) Append(actionType ActionType, actorRef string, payload any, idempotencyKey string) (*AuditLogEntry, error) {
	if !actionType.Valid() {
		return nil, validationError("invalid action_type")
	}
	if actorRef == "" {
		return nil, validationError("actor_ref is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if idempotencyKey != "" {
		if id, ok := s.idem[idempotencyKey]; ok {
			existing := s.byID[id]
			return &existing, nil
		}
	}

	prevHash := s.tipRowHashLocked()
	entry, err := buildEntry(generateID(), actionType, actorRef, payload, prevHash, time.Now().UTC(), s.signingKey)
	if err != nil {
		return nil, err
	}
	if !s.linkEntryLocked(entry) {
		return nil, validationError("failed to link entry to chain tip")
	}
	if idempotencyKey != "" {
		s.idem[idempotencyKey] = entry.ID
	}
	return &entry, nil
}

// linkEntry is the lower-level chain-linking primitive: it accepts an
// already-built entry whose prev_hash claims to link to a specific hash. If
// that hash is the current tip, the entry (and any buffered entries that
// become linkable as a result) is committed; otherwise the entry is
// buffered until an entry producing that row hash arrives. Returns whether
// the given entry ended up in the chain immediately.
func (s *Store) linkEntry(entry AuditLogEntry) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.linkEntryLocked(entry)
}

func (s *Store) linkEntryLocked(entry AuditLogEntry) bool {
	if _, exists := s.byID[entry.ID]; exists {
		return true
	}
	if entry.PrevHash != s.tipRowHashLocked() {
		s.pending[entry.PrevHash] = entry
		return false
	}

	s.commitLocked(entry)
	rowHash := computeRowHash(entry)
	for {
		next, ok := s.pending[rowHash]
		if !ok {
			break
		}
		delete(s.pending, rowHash)
		s.commitLocked(next)
		rowHash = computeRowHash(next)
	}
	return true
}

func (s *Store) commitLocked(entry AuditLogEntry) {
	s.entries = append(s.entries, entry)
	s.byID[entry.ID] = entry
}

func (s *Store) tipRowHashLocked() string {
	if len(s.entries) == 0 {
		return genesisHash
	}
	return computeRowHash(s.entries[len(s.entries)-1])
}

func (s *Store) ListLog(filter ActionType) []AuditLogEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]AuditLogEntry, 0, len(s.entries))
	for _, e := range s.entries {
		if filter != "" && e.ActionType != filter {
			continue
		}
		result = append(result, e)
	}
	return result
}

func (s *Store) VerifyChainIntegrity() (valid bool, brokenAtID string, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	expectedPrev := genesisHash
	for _, e := range s.entries {
		if e.PrevHash != expectedPrev {
			return false, e.ID, nil
		}
		rowHash := computeRowHash(e)
		if e.Signature != computeSignature(rowHash, s.signingKey) {
			return false, e.ID, nil
		}
		expectedPrev = rowHash
	}
	return true, "", nil
}

func (s *Store) CreateRight(name, description string, protected bool) (*ConstitutionalRight, error) {
	if name == "" {
		return nil, validationError("name is required")
	}
	right := ConstitutionalRight{
		ID:          generateID(),
		Name:        name,
		Description: description,
		Protected:   protected,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.rights = append(s.rights, right)
	return &right, nil
}

func (s *Store) ListRights() []ConstitutionalRight {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ConstitutionalRight, len(s.rights))
	copy(result, s.rights)
	return result
}

func (s *Store) ProtectedRights() []ConstitutionalRight {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []ConstitutionalRight
	for _, r := range s.rights {
		if r.Protected {
			result = append(result, r)
		}
	}
	return result
}

func (s *Store) recordReview(review ConstitutionalReview) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reviews = append(s.reviews, review)
}

func (s *Store) ListReviews() []ConstitutionalReview {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ConstitutionalReview, len(s.reviews))
	copy(result, s.reviews)
	return result
}
