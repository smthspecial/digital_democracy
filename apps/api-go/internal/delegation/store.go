package delegation

import (
	"sync"
	"time"
)

// MemoryStore is the in-memory Store implementation (ARCH-009): safe for
// concurrent use, and chain snapshots hold the read lock so cycle checks and
// resolution see a consistent graph. Methods return nil errors; the error
// exists for parity with PGStore.
type MemoryStore struct {
	mu          sync.RWMutex
	delegations map[string]*Delegation
}

func NewStore() *MemoryStore {
	return &MemoryStore{delegations: make(map[string]*Delegation)}
}

func (st *MemoryStore) Insert(d *Delegation) (*Delegation, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	d.ID = newID()
	d.CreatedAt = time.Now().UTC()
	st.delegations[d.ID] = d
	c := *d
	return &c, nil
}

func (st *MemoryStore) Get(id string) (*Delegation, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	d, ok := st.delegations[id]
	if !ok {
		return nil, ErrNotFound
	}
	c := *d
	return &c, nil
}

// List returns copies, optionally filtered (empty filter = all). Revoked and
// expired rows are included: delegations are publicly visible history.
func (st *MemoryStore) List(delegatorID, delegateID, domainID string) ([]*Delegation, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*Delegation
	for _, d := range st.delegations {
		if delegatorID != "" && d.DelegatorID != delegatorID {
			continue
		}
		if delegateID != "" && d.DelegateID != delegateID {
			continue
		}
		if domainID != "" && d.DomainID != domainID {
			continue
		}
		c := *d
		out = append(out, &c)
	}
	return out, nil
}

// Revoke sets revoked_at (DP-015). Idempotent: revoking twice returns the
// same row.
func (st *MemoryStore) Revoke(id string, now time.Time) (*Delegation, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	d, ok := st.delegations[id]
	if !ok {
		return nil, ErrNotFound
	}
	if d.RevokedAt == nil {
		d.RevokedAt = &now
	}
	c := *d
	return &c, nil
}

// ExpireDue runs DP-045: every unrevoked delegation past expires_at is
// revoked. Returns the revoked rows.
func (st *MemoryStore) ExpireDue(now time.Time) ([]*Delegation, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	var out []*Delegation
	for _, d := range st.delegations {
		if d.RevokedAt == nil && !d.ExpiresAt.After(now) {
			t := now
			d.RevokedAt = &t
			c := *d
			out = append(out, &c)
		}
	}
	return out, nil
}

// ActiveDelegations returns currently effective delegations in a domain.
// Graph walks live in service.go so both backends share them.
func (st *MemoryStore) ActiveDelegations(domainID string, now time.Time) ([]*Delegation, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	var out []*Delegation
	for _, d := range st.delegations {
		if d.DomainID == domainID && d.Active(now) {
			c := *d
			out = append(out, &c)
		}
	}
	return out, nil
}
