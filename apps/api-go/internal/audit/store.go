package audit

import (
	"sync"
	"time"
)

// MemoryStore is the in-memory Store implementation (ARCH-009). The log is
// append-only by construction: no update or delete method exists. Insertion
// order is preserved in `entries` so chain verification and ordered reads
// never depend on timestamp granularity under concurrent inserts. Methods
// return nil errors; the error exists for parity with PGStore.
type MemoryStore struct {
	mu sync.RWMutex

	entries []*AuditEntry
	byID    map[string]*AuditEntry
	// byIdempotencyKey implements DP-036 at-least-once dedupe: the first
	// append wins, redeliveries return the original row (ADR-023).
	byIdempotencyKey map[string]*AuditEntry

	rights  map[string]*ConstitutionalRight
	reviews map[string]*ConstitutionalReview
	// reviewsByProposal indexes review ids per proposal.
	reviewsByProposal map[string][]string

	changes map[string]*ProtocolChange
}

func NewStore() *MemoryStore {
	return &MemoryStore{
		byID:              make(map[string]*AuditEntry),
		byIdempotencyKey:  make(map[string]*AuditEntry),
		rights:            make(map[string]*ConstitutionalRight),
		reviews:           make(map[string]*ConstitutionalReview),
		reviewsByProposal: make(map[string][]string),
		changes:           make(map[string]*ProtocolChange),
	}
}

// Append inserts one hash-chained entry. With a non-empty idempotency key, a
// redelivered event returns the original entry without writing (dedupe).
func (st *MemoryStore) Append(actionType, actorRef, payload, idempotencyKey string) (*AuditEntry, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if idempotencyKey != "" {
		if existing, ok := st.byIdempotencyKey[idempotencyKey]; ok {
			c := *existing
			return &c, nil
		}
	}
	prev := GenesisPrevHash
	if len(st.entries) > 0 {
		// Chain rule (ARCH-023 §4.4, mirrored by the SQL trigger):
		// prev_hash equals the previous row's payload_hash, or GENESIS.
		prev = st.entries[len(st.entries)-1].PayloadHash
	}
	payloadHash := sha256Hex(payload)
	e := &AuditEntry{
		ID:             newID(),
		ActionType:     actionType,
		ActorRef:       actorRef,
		PayloadHash:    payloadHash,
		PrevHash:       prev,
		CreatedAt:      time.Now().UTC(),
		IdempotencyKey: idempotencyKey,
	}
	e.Hash = chainHash(e.PrevHash, e.PayloadHash, e.ActionType, e.ActorRef)
	// Signature is a placeholder for service-key signing (KMS/HSM in
	// production): verifiable provenance per writer, same field.
	e.Signature = "sig:" + sha256Hex(e.Hash+".audit-service")
	st.entries = append(st.entries, e)
	st.byID[e.ID] = e
	if idempotencyKey != "" {
		st.byIdempotencyKey[idempotencyKey] = e
	}
	c := *e
	return &c, nil
}

func (st *MemoryStore) GetEntry(id string) (*AuditEntry, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	e, ok := st.byID[id]
	if !ok {
		return nil, ErrNotFound
	}
	c := *e
	return &c, nil
}

// ListEntries returns entries in append order (oldest first). Limit <= 0
// means all.
func (st *MemoryStore) ListEntries(limit int) ([]*AuditEntry, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	n := len(st.entries)
	if limit > 0 && limit < n {
		n = limit
	}
	out := make([]*AuditEntry, 0, n)
	for _, e := range st.entries[:n] {
		c := *e
		out = append(out, &c)
	}
	return out, nil
}

func (st *MemoryStore) Count() (int, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return len(st.entries), nil
}

// VerifyChain recomputes every link and reports the first break (gap
// detection, SRV-012 key rules). Returns the index of the first bad entry.
func (st *MemoryStore) VerifyChain() (bool, int, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	prev := GenesisPrevHash
	for i, e := range st.entries {
		if e.PrevHash != prev {
			return false, i, nil
		}
		if e.Hash != chainHash(e.PrevHash, e.PayloadHash, e.ActionType, e.ActorRef) {
			return false, i, nil
		}
		prev = e.PayloadHash
	}
	return true, -1, nil
}

func (st *MemoryStore) CreateRight(name, description string, protected bool) (*ConstitutionalRight, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	r := &ConstitutionalRight{ID: newID(), Name: name, Description: description, Protected: protected}
	st.rights[r.ID] = r
	c := *r
	return &c, nil
}

func (st *MemoryStore) ListRights() ([]*ConstitutionalRight, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := make([]*ConstitutionalRight, 0, len(st.rights))
	for _, r := range st.rights {
		c := *r
		out = append(out, &c)
	}
	return out, nil
}

func (st *MemoryStore) AddReview(rev *ConstitutionalReview) (*ConstitutionalReview, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	rev.ID = newID()
	rev.CreatedAt = time.Now().UTC()
	st.reviews[rev.ID] = rev
	st.reviewsByProposal[rev.ProposalID] = append(st.reviewsByProposal[rev.ProposalID], rev.ID)
	c := *rev
	return &c, nil
}

func (st *MemoryStore) ListReviews(proposalID string) ([]*ConstitutionalReview, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*ConstitutionalReview
	if proposalID != "" {
		for _, id := range st.reviewsByProposal[proposalID] {
			c := *st.reviews[id]
			out = append(out, &c)
		}
		return out, nil
	}
	for _, r := range st.reviews {
		c := *r
		out = append(out, &c)
	}
	return out, nil
}

func (st *MemoryStore) InsertProtocolChange(c *ProtocolChange) (*ProtocolChange, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	c.ID = newID()
	c.CreatedAt = time.Now().UTC()
	st.changes[c.ID] = c
	out := *c
	return &out, nil
}

func (st *MemoryStore) GetProtocolChange(id string) (*ProtocolChange, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	c, ok := st.changes[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := *c
	return &out, nil
}

func (st *MemoryStore) ListProtocolChanges() ([]*ProtocolChange, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := make([]*ProtocolChange, 0, len(st.changes))
	for _, c := range st.changes {
		cp := *c
		out = append(out, &cp)
	}
	return out, nil
}

func (st *MemoryStore) UpdateProtocolChange(c *ProtocolChange) (*ProtocolChange, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.changes[c.ID]; !ok {
		return nil, ErrNotFound
	}
	st.changes[c.ID] = c
	out := *c
	return &out, nil
}
