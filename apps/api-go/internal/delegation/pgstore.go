package delegation

import (
	"context"
	"errors"
	"time"

	"github.com/digital-democracy/api-go/internal/pgconv"
	delegationdb "github.com/digital-democracy/api-go/internal/sqlc/delegation"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore implements Store on Postgres via the sqlc-generated queries
// (ADR-029). Graph walks run in Service over ActiveDelegations, so both
// backends share cycle and chain logic exactly.
type PGStore struct {
	pool *pgxpool.Pool
	q    *delegationdb.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{pool: pool, q: delegationdb.New(pool)}
}

func opCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func mapNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func delegationFromRow(r delegationdb.Delegation) *Delegation {
	d := &Delegation{
		ID:          pgconv.UUIDToString(r.ID),
		DelegatorID: pgconv.UUIDToString(r.DelegatorID),
		DelegateID:  pgconv.UUIDToString(r.DelegateID),
		DomainID:    pgconv.UUIDToString(r.DomainID),
		CreatedAt:   pgconv.Time(r.CreatedAt),
		ExpiresAt:   pgconv.Time(r.ExpiresAt),
	}
	if r.RevokedAt.Valid {
		t := r.RevokedAt.Time
		d.RevokedAt = &t
	}
	return d
}

func (s *PGStore) Insert(d *Delegation) (*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	delegator, err := pgconv.UUIDFromString(d.DelegatorID)
	if err != nil {
		return nil, err
	}
	delegate, err := pgconv.UUIDFromString(d.DelegateID)
	if err != nil {
		return nil, err
	}
	domain, err := pgconv.UUIDFromString(d.DomainID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.CreateDelegation(ctx, delegationdb.CreateDelegationParams{
		ID:          pgconv.MustUUID(newID()),
		DelegatorID: delegator,
		DelegateID:  delegate,
		DomainID:    domain,
		ExpiresAt:   pgconv.TSTZ(d.ExpiresAt),
	})
	if err != nil {
		return nil, err
	}
	return delegationFromRow(row), nil
}

func (s *PGStore) Get(id string) (*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.GetDelegation(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return delegationFromRow(row), nil
}

func (s *PGStore) List(delegatorID, delegateID, domainID string) ([]*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ListAllDelegations(ctx)
	if err != nil {
		return nil, err
	}
	var out []*Delegation
	for _, r := range rows {
		d := delegationFromRow(r)
		if delegatorID != "" && d.DelegatorID != delegatorID {
			continue
		}
		if delegateID != "" && d.DelegateID != delegateID {
			continue
		}
		if domainID != "" && d.DomainID != domainID {
			continue
		}
		out = append(out, d)
	}
	return out, nil
}

func (s *PGStore) Revoke(id string, now time.Time) (*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.RevokeDelegation(ctx, delegationdb.RevokeDelegationParams{ID: uid, RevokedAt: pgconv.TSTZ(now)})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return delegationFromRow(row), nil
}

func (s *PGStore) ExpireDue(now time.Time) ([]*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ExpireDueDelegations(ctx, pgconv.TSTZ(now))
	if err != nil {
		return nil, err
	}
	out := make([]*Delegation, 0, len(rows))
	for _, r := range rows {
		out = append(out, delegationFromRow(r))
	}
	return out, nil
}

func (s *PGStore) ActiveDelegations(domainID string, now time.Time) ([]*Delegation, error) {
	ctx, cancel := opCtx()
	defer cancel()
	domain, err := pgconv.UUIDFromString(domainID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListActiveDomainEdges(ctx, delegationdb.ListActiveDomainEdgesParams{
		DomainID:  domain,
		ExpiresAt: pgconv.TSTZ(now),
	})
	if err != nil {
		return nil, err
	}
	out := make([]*Delegation, 0, len(rows))
	for _, r := range rows {
		// Edge endpoints only: walks never read timestamps. ExpiresAt stays
		// zero rather than carrying a misleading marker.
		out = append(out, &Delegation{
			DelegatorID: pgconv.UUIDToString(r.DelegatorID),
			DelegateID:  pgconv.UUIDToString(r.DelegateID),
			DomainID:    domainID,
		})
	}
	return out, nil
}
