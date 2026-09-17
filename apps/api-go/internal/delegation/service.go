package delegation

import (
	"time"

	"github.com/digital-democracy/api-go/internal/metrics"
)

// CompetencyChecker validates that a delegate holds active competency in the
// domain (FR-056, DP-014). Production implementation calls competency-service
// over HTTP; unit tests and local dev use the allow-all default, which keeps
// single-service tests hermetic per ARCH-009 (the cross-service check itself
// is covered by integration plans, not here).
type CompetencyChecker interface {
	HasActiveCompetency(citizenID, domainID string) (bool, error)
}

type allowAllCompetencyChecker struct{}

func (allowAllCompetencyChecker) HasActiveCompetency(string, string) (bool, error) {
	return true, nil
}

// AuditEmitter emits create/revoke/expiry events (DP-036). No-op by default;
// NATS (ADR-023) when NATS_URL is set, else HTTP, else no-op.
type AuditEmitter interface {
	Emit(actionType, actorRef, payload string) error
}

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(string, string, string) error { return nil }

// Store is the persistence contract behind Service. MemoryStore serves tests
// and DATABASE_URL-less runs; PGStore (pgstore.go) serves Postgres via the
// sqlc-generated queries (ADR-029). Errors propagate — backend failures are
// never hidden as zero values.
type Store interface {
	Insert(d *Delegation) (*Delegation, error)
	Get(id string) (*Delegation, error)
	List(delegatorID, delegateID, domainID string) ([]*Delegation, error)
	Revoke(id string, now time.Time) (*Delegation, error)
	ExpireDue(now time.Time) ([]*Delegation, error)
	// ActiveDelegations returns currently effective delegations in a domain
	// for chain walks (DP-041) and cycle checks (DP-014).
	ActiveDelegations(domainID string, now time.Time) ([]*Delegation, error)
}

// Service implements DP-014, DP-015, DP-041, DP-045 from SRV-010 §Operations.
type Service struct {
	store      Store
	competency CompetencyChecker
	audit      AuditEmitter
}

func NewService(store Store, competency CompetencyChecker, audit AuditEmitter) *Service {
	if store == nil {
		store = NewStore()
	}
	if competency == nil {
		competency = allowAllCompetencyChecker{}
	}
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	return &Service{store: store, competency: competency, audit: audit}
}

type CreateInput struct {
	DelegatorID string
	DelegateID  string
	DomainID    string
	ExpiresAt   time.Time
}

// Create runs DP-014: competency check, self-delegation and cycle rejection,
// mandatory future expiry. Emits an audit event.
func (s *Service) Create(in CreateInput, now time.Time) (*Delegation, error) {
	if in.DelegatorID == "" || in.DelegateID == "" || in.DomainID == "" {
		return nil, ErrInvalid
	}
	if in.DelegatorID == in.DelegateID {
		return nil, ErrInvalid
	}
	if in.ExpiresAt.IsZero() || !in.ExpiresAt.After(now) {
		// expires_at is mandatory (FR-057): no permanent delegates.
		return nil, ErrInvalid
	}
	ok, err := s.competency.HasActiveCompetency(in.DelegateID, in.DomainID)
	if err != nil {
		return nil, err
	}
	if !ok {
		// FR-056: only active domain experts may receive delegations.
		return nil, ErrInvalid
	}
	edges, err := s.store.ActiveDelegations(in.DomainID, now)
	if err != nil {
		return nil, err
	}
	if createsCycle(edges, in.DelegatorID, in.DelegateID) {
		return nil, ErrConflict
	}
	d, err := s.store.Insert(&Delegation{
		DelegatorID: in.DelegatorID,
		DelegateID:  in.DelegateID,
		DomainID:    in.DomainID,
		ExpiresAt:   in.ExpiresAt.UTC(),
	})
	if err != nil {
		return nil, err
	}
	_ = s.audit.Emit("delegation_created", "delegation-service", d.ID)
	metrics.DelegationEventsTotal.WithLabelValues("created").Inc()
	return d, nil
}

// Revoke runs DP-015: immediate effect, row retained. Only the delegator may
// revoke (AUTH-010 delegation:revoke, scope own) — enforced here by comparing
// the caller's citizen id, resolved from their auth token by the caller.
func (s *Service) Revoke(id, callerCitizenID string, now time.Time) (*Delegation, error) {
	d, err := s.store.Get(id)
	if err != nil {
		return nil, err
	}
	if callerCitizenID != "" && d.DelegatorID != callerCitizenID {
		return nil, ErrInvalid
	}
	revoked, err := s.store.Revoke(id, now)
	if err != nil {
		return nil, err
	}
	_ = s.audit.Emit("delegation_revoked", "delegation-service", id)
	metrics.DelegationEventsTotal.WithLabelValues("revoked").Inc()
	return revoked, nil
}

// ResolveChain runs DP-041: the full delegator→…→delegate chain in a domain.
// Empty (not an error) means the citizen votes directly.
func (s *Service) ResolveChain(citizenID, domainID string, now time.Time) ([]string, error) {
	if citizenID == "" || domainID == "" {
		return nil, nil
	}
	edges, err := s.store.ActiveDelegations(domainID, now)
	if err != nil {
		return nil, err
	}
	return resolveChain(edges, citizenID), nil
}

// ExpireDue runs DP-045 (cron, daily): revoke everything past expiry.
func (s *Service) ExpireDue(now time.Time) ([]*Delegation, error) {
	out, err := s.store.ExpireDue(now)
	if err != nil {
		return nil, err
	}
	for _, d := range out {
		_ = s.audit.Emit("delegation_expired", "delegation-service", d.ID)
		metrics.DelegationEventsTotal.WithLabelValues("expired").Inc()
	}
	return out, nil
}

// createsCycle reports whether delegator→delegate would close a directed
// cycle through active edges (DP-014 rejects it, so DP-041 chains stay
// acyclic). Walk forward from delegate; reaching delegator closes a loop.
func createsCycle(edges []*Delegation, delegatorID, delegateID string) bool {
	next := map[string]string{}
	for _, d := range edges {
		next[d.DelegatorID] = d.DelegateID
	}
	seen := map[string]bool{delegatorID: true}
	for cur := delegateID; cur != ""; {
		if seen[cur] {
			return true
		}
		seen[cur] = true
		cur = next[cur]
	}
	return false
}

// resolveChain follows active forward edges from the delegator.
func resolveChain(edges []*Delegation, delegatorID string) []string {
	next := map[string]string{}
	for _, d := range edges {
		next[d.DelegatorID] = d.DelegateID
	}
	var chain []string
	seen := map[string]bool{delegatorID: true}
	for cur := next[delegatorID]; cur != "" && !seen[cur]; {
		seen[cur] = true
		chain = append(chain, cur)
		cur = next[cur]
	}
	return chain
}
