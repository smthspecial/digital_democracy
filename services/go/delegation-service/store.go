package main

import (
	"sync"
	"time"
)

// Store is an in-memory, thread-safe repository for delegations. All
// mutations that must observe or preserve a graph invariant (acyclicity,
// single-revoke) happen under one lock acquisition so concurrent writers
// can't race past each other's checks.
type Store struct {
	mu    sync.RWMutex
	byID  map[string]*Delegation
	order []string
}

func NewStore() *Store {
	return &Store{byID: make(map[string]*Delegation)}
}

func (s *Store) Get(id string) (*Delegation, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.byID[id]
	if !ok {
		return nil, false
	}
	cp := *d
	return &cp, true
}

func (s *Store) List(filter ListFilter) []*Delegation {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*Delegation, 0, len(s.order))
	for _, id := range s.order {
		d := s.byID[id]
		if filter.DelegatorID != "" && d.DelegatorID != filter.DelegatorID {
			continue
		}
		if filter.DelegateID != "" && d.DelegateID != filter.DelegateID {
			continue
		}
		if filter.DomainID != "" && d.DomainID != filter.DomainID {
			continue
		}
		cp := *d
		result = append(result, &cp)
	}
	return result
}

// InsertIfAcyclic checks, under the same lock as the write, whether adding
// delegatorID->delegateID would close a cycle in the active delegator->
// delegate graph for this domain (i.e. delegateID can already reach
// delegatorID by following active outgoing delegations), and rejects it if
// so; otherwise it inserts the row.
func (s *Store) InsertIfAcyclic(d *Delegation, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.canReachLocked(d.DelegateID, d.DelegatorID, d.DomainID, now) {
		return ErrCircularDelegation
	}
	cp := *d
	s.byID[d.ID] = &cp
	s.order = append(s.order, d.ID)
	return nil
}

func (s *Store) canReachLocked(from, to, domainID string, at time.Time) bool {
	if from == to {
		return true
	}
	visited := map[string]bool{from: true}
	queue := []string{from}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, id := range s.order {
			d := s.byID[id]
			if d.DomainID != domainID || d.DelegatorID != current || !d.activeAt(at) {
				continue
			}
			next := d.DelegateID
			if next == to {
				return true
			}
			if !visited[next] {
				visited[next] = true
				queue = append(queue, next)
			}
		}
	}
	return false
}

// Revoke atomically validates ownership and revocation state, then sets
// revoked_at -- ownership/conflict checks must observe the same snapshot
// they mutate, or two concurrent revokes could both "succeed".
func (s *Store) Revoke(id, requestingCitizenID string, now time.Time) (*Delegation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.byID[id]
	if !ok {
		return nil, ErrDelegationNotFound
	}
	if d.DelegatorID != requestingCitizenID {
		return nil, ErrNotDelegator
	}
	if d.RevokedAt != nil {
		return nil, ErrAlreadyRevoked
	}
	d.RevokedAt = &now
	cp := *d
	return &cp, nil
}

// ExpireDelegations sets revoked_at=now on every row with expires_at < now
// and revoked_at still nil, returning the rows it affected. The condition
// excludes already-revoked rows, so a repeat call is a no-op.
func (s *Store) ExpireDelegations(now time.Time) []*Delegation {
	s.mu.Lock()
	defer s.mu.Unlock()
	var expired []*Delegation
	for _, id := range s.order {
		d := s.byID[id]
		if d.RevokedAt == nil && d.ExpiresAt.Before(now) {
			d.RevokedAt = &now
			cp := *d
			expired = append(expired, &cp)
		}
	}
	return expired
}

// ReverseActiveWalk returns every citizen ID whose active-as-of-at
// delegation chain (direct or transitive, within domainID) terminates at
// delegateID, by walking the reverse graph breadth-first. The forward graph
// is acyclic by construction (InsertIfAcyclic), so this always terminates.
func (s *Store) ReverseActiveWalk(delegateID, domainID string, at time.Time) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	visited := map[string]bool{}
	var result []string
	queue := []string{delegateID}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, id := range s.order {
			d := s.byID[id]
			if d.DomainID != domainID || d.DelegateID != current || !d.activeAt(at) {
				continue
			}
			delegator := d.DelegatorID
			if visited[delegator] {
				continue
			}
			visited[delegator] = true
			result = append(result, delegator)
			queue = append(queue, delegator)
		}
	}
	return result
}
