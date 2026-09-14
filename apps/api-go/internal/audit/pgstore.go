package audit

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/digital-democracy/api-go/internal/pgconv"
	auditdb "github.com/digital-democracy/api-go/internal/sqlc/audit"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// auditAdvisoryLock serializes appends across processes so concurrent writers
// cannot interleave chain tips (the in-memory store uses a mutex for the
// same purpose). Advisory locks are session... transaction-scoped here
// (pg_advisory_xact_lock releases on commit/rollback automatically).
const auditAdvisoryLock = 42036001

// PGStore implements Store on Postgres via the sqlc-generated queries
// (ADR-029). Append holds the advisory lock in a transaction: tip read +
// insert are atomic, and the SQL chain trigger re-validates prev_hash.
type PGStore struct {
	pool *pgxpool.Pool
	q    *auditdb.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{pool: pool, q: auditdb.New(pool)}
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

func entryFromRow(r auditdb.AuditLog) *AuditEntry {
	return &AuditEntry{
		ID:             pgconv.UUIDToString(r.ID),
		ActionType:     r.ActionType,
		ActorRef:       r.ActorRef,
		PayloadHash:    r.PayloadHash,
		PrevHash:       r.PrevHash,
		Hash:           chainHash(r.PrevHash, r.PayloadHash, r.ActionType, r.ActorRef),
		Signature:      r.Signature,
		IdempotencyKey: pgconv.Text(r.IdempotencyKey),
		CreatedAt:      pgconv.Time(r.CreatedAt),
	}
}

func (s *PGStore) Append(actionType, actorRef, payload, idempotencyKey string) (*AuditEntry, error) {
	ctx, cancel := opCtx()
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, auditAdvisoryLock); err != nil {
		return nil, err
	}
	qtx := s.q.WithTx(tx)
	if idempotencyKey != "" {
		if existing, err := qtx.GetEntryByIdempotencyKey(ctx, pgconv.TextNull(idempotencyKey)); err == nil {
			_ = tx.Commit(ctx)
			return entryFromRow(existing), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	tip, err := qtx.GetAuditTip(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	prev := GenesisPrevHash
	if err == nil {
		prev = tip
	}
	payloadHash := sha256Hex(payload)
	hash := chainHash(prev, payloadHash, actionType, actorRef)
	row, err := qtx.InsertAuditEntry(ctx, auditdb.InsertAuditEntryParams{
		ID:             pgconv.MustUUID(newID()),
		ActionType:     actionType,
		ActorRef:       actorRef,
		PayloadHash:    payloadHash,
		PrevHash:       prev,
		Signature:      "sig:" + sha256Hex(hash+".audit-service"),
		IdempotencyKey: pgconv.TextNull(idempotencyKey),
	})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return entryFromRow(row), nil
}

func (s *PGStore) GetEntry(id string) (*AuditEntry, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.GetAuditEntry(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return entryFromRow(row), nil
}

func (s *PGStore) ListEntries(limit int) ([]*AuditEntry, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ListAuditEntries(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	out := make([]*AuditEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, entryFromRow(r))
	}
	return out, nil
}

func (s *PGStore) Count() (int, error) {
	ctx, cancel := opCtx()
	defer cancel()
	n, err := s.q.CountAuditEntries(ctx)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *PGStore) VerifyChain() (bool, int, error) {
	entries, err := s.ListEntries(0)
	if err != nil {
		return false, -1, err
	}
	prev := GenesisPrevHash
	for i, e := range entries {
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

func (s *PGStore) CreateRight(name, description string, protected bool) (*ConstitutionalRight, error) {
	ctx, cancel := opCtx()
	defer cancel()
	row, err := s.q.CreateConstitutionalRight(ctx, auditdb.CreateConstitutionalRightParams{
		ID:          pgconv.MustUUID(newID()),
		Name:        name,
		Description: description,
		Protected:   protected,
	})
	if err != nil {
		return nil, err
	}
	return &ConstitutionalRight{
		ID:          pgconv.UUIDToString(row.ID),
		Name:        row.Name,
		Description: row.Description,
		Protected:   row.Protected,
	}, nil
}

func (s *PGStore) ListRights() ([]*ConstitutionalRight, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ListConstitutionalRights(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*ConstitutionalRight, 0, len(rows))
	for _, r := range rows {
		out = append(out, &ConstitutionalRight{
			ID:          pgconv.UUIDToString(r.ID),
			Name:        r.Name,
			Description: r.Description,
			Protected:   r.Protected,
		})
	}
	return out, nil
}

func (s *PGStore) AddReview(rev *ConstitutionalReview) (*ConstitutionalReview, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rightID, err := pgconv.UUIDFromString(rev.RightID)
	if err != nil {
		return nil, err
	}
	proposalID, err := pgconv.UUIDFromString(rev.ProposalID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.InsertConstitutionalReview(ctx, auditdb.InsertConstitutionalReviewParams{
		ID:          pgconv.MustUUID(newID()),
		ProposalID:  proposalID,
		RightID:     rightID,
		Result:      rev.Result,
		ReviewerRef: rev.ReviewerRef,
	})
	if err != nil {
		return nil, err
	}
	return &ConstitutionalReview{
		ID:          pgconv.UUIDToString(row.ID),
		ProposalID:  pgconv.UUIDToString(row.ProposalID),
		RightID:     pgconv.UUIDToString(row.RightID),
		Result:      row.Result,
		ReviewerRef: row.ReviewerRef,
		CreatedAt:   pgconv.Time(row.CreatedAt),
	}, nil
}

func (s *PGStore) ListReviews(proposalID string) ([]*ConstitutionalReview, error) {
	ctx, cancel := opCtx()
	defer cancel()
	var rows []auditdb.ConstitutionalReview
	var err error
	if proposalID != "" {
		pid, perr := pgconv.UUIDFromString(proposalID)
		if perr != nil {
			return nil, perr
		}
		rows, err = s.q.ListReviewsByProposal(ctx, pid)
	} else {
		rows, err = s.q.ListAllReviews(ctx)
	}
	if err != nil {
		return nil, err
	}
	out := make([]*ConstitutionalReview, 0, len(rows))
	for _, r := range rows {
		out = append(out, &ConstitutionalReview{
			ID:          pgconv.UUIDToString(r.ID),
			ProposalID:  pgconv.UUIDToString(r.ProposalID),
			RightID:     pgconv.UUIDToString(r.RightID),
			Result:      r.Result,
			ReviewerRef: r.ReviewerRef,
			CreatedAt:   pgconv.Time(r.CreatedAt),
		})
	}
	return out, nil
}

func changeFromRow(r auditdb.ProtocolChange) (*ProtocolChange, error) {
	var approvals []ProtocolApproval
	if len(r.Approvals) > 0 {
		if err := json.Unmarshal(r.Approvals, &approvals); err != nil {
			return nil, err
		}
	}
	c := &ProtocolChange{
		ID:                pgconv.UUIDToString(r.ID),
		ChangeRef:         r.ChangeRef,
		RequiredApprovals: r.RequiredApprovalRefs,
		Approvals:         approvals,
		DelayUntil:        pgconv.Time(r.DelayUntil),
		VisibleSince:      pgconv.Time(r.VisibleSince),
		Status:            r.Status,
		CreatedAt:         pgconv.Time(r.CreatedAt),
	}
	if r.ReleasedAt.Valid {
		t := r.ReleasedAt.Time
		c.ReleasedAt = &t
	}
	return c, nil
}

func (s *PGStore) InsertProtocolChange(c *ProtocolChange) (*ProtocolChange, error) {
	ctx, cancel := opCtx()
	defer cancel()
	raw, err := json.Marshal(c.Approvals)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		raw = []byte("[]")
	}
	row, err := s.q.InsertProtocolChange(ctx, auditdb.InsertProtocolChangeParams{
		ID:                   pgconv.MustUUID(newID()),
		ChangeRef:            c.ChangeRef,
		RequiredApprovalRefs: c.RequiredApprovals,
		Approvals:            raw,
		DelayUntil:           pgconv.TSTZ(c.DelayUntil),
		VisibleSince:         pgconv.TSTZ(c.VisibleSince),
		Status:               ChangePending,
	})
	if err != nil {
		return nil, err
	}
	return changeFromRow(row)
}

func (s *PGStore) GetProtocolChange(id string) (*ProtocolChange, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.GetProtocolChange(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return changeFromRow(row)
}

func (s *PGStore) ListProtocolChanges() ([]*ProtocolChange, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ListProtocolChanges(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*ProtocolChange, 0, len(rows))
	for _, r := range rows {
		c, err := changeFromRow(r)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func (s *PGStore) UpdateProtocolChange(c *ProtocolChange) (*ProtocolChange, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(c.ID)
	if err != nil {
		return nil, ErrNotFound
	}
	raw, err := json.Marshal(c.Approvals)
	if err != nil {
		return nil, err
	}
	row, err := s.q.UpdateProtocolChange(ctx, auditdb.UpdateProtocolChangeParams{
		ID:         uid,
		Approvals:  raw,
		Status:     c.Status,
		ReleasedAt: pgconv.TSTZNull(timeOrZero(c.ReleasedAt)),
	})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return changeFromRow(row)
}

func timeOrZero(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
