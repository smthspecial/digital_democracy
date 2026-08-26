package main

import "time"

// CompetencyChecker models the read from competency-service (SRV-010's
// "Reads from" dependency, not yet implemented as a live service in this
// codebase); the default implementation allows every delegate.
type CompetencyChecker interface {
	HasActiveCompetency(citizenID, domainID string) bool
}

type defaultCompetencyChecker struct{}

func (defaultCompetencyChecker) HasActiveCompetency(citizenID, domainID string) bool {
	return true
}

// AuditEmitter models DP-036's async append to the hash-chained audit log
// (audit-service, not yet implemented as a live service here); the default
// implementation is a no-op.
type AuditEmitter interface {
	Emit(event string, d *Delegation)
}

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(event string, d *Delegation) {}

type Service struct {
	store      *Store
	competency CompetencyChecker
	audit      AuditEmitter
}

func NewService(store *Store, competency CompetencyChecker, audit AuditEmitter) *Service {
	if competency == nil {
		competency = defaultCompetencyChecker{}
	}
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	return &Service{store: store, competency: competency, audit: audit}
}

// CreateDelegation implements DP-014.
func (s *Service) CreateDelegation(delegatorID, delegateID, domainID string, expiresAt, now time.Time) (*Delegation, error) {
	if delegatorID == "" || delegateID == "" || domainID == "" {
		return nil, ErrValidation
	}
	if delegatorID == delegateID {
		return nil, ErrSelfDelegation
	}
	if !expiresAt.After(now) {
		return nil, ErrExpiryNotFuture
	}
	if !s.competency.HasActiveCompetency(delegateID, domainID) {
		return nil, ErrNoCompetency
	}

	d := &Delegation{
		ID:          newID(),
		DelegatorID: delegatorID,
		DelegateID:  delegateID,
		DomainID:    domainID,
		CreatedAt:   now,
		ExpiresAt:   expiresAt,
	}
	if err := s.store.InsertIfAcyclic(d, now); err != nil {
		return nil, err
	}
	s.audit.Emit("delegation.created", d)
	cp := *d
	return &cp, nil
}

// RevokeDelegation implements DP-015.
func (s *Service) RevokeDelegation(id, requestingCitizenID string, now time.Time) (*Delegation, error) {
	d, err := s.store.Revoke(id, requestingCitizenID, now)
	if err != nil {
		return nil, err
	}
	s.audit.Emit("delegation.revoked", d)
	return d, nil
}

// ResolveChain implements DP-041.
func (s *Service) ResolveChain(delegateID, domainID string, at time.Time) ([]string, error) {
	if delegateID == "" || domainID == "" {
		return nil, ErrValidation
	}
	ids := s.store.ReverseActiveWalk(delegateID, domainID, at)
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}

// ExpireDelegations implements DP-045.
func (s *Service) ExpireDelegations(now time.Time) (int, error) {
	expired := s.store.ExpireDelegations(now)
	for _, d := range expired {
		s.audit.Emit("delegation.expired", d)
	}
	return len(expired), nil
}

// ListDelegations implements the FR-056 public-visibility read.
func (s *Service) ListDelegations(filter ListFilter) []*Delegation {
	return s.store.List(filter)
}
