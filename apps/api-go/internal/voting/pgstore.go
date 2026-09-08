package voting

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/digital-democracy/api-go/internal/pgconv"
	votingdb "github.com/digital-democracy/api-go/internal/sqlc/voting"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore implements Store on Postgres via the sqlc-generated queries
// (ADR-029). Behavior matches MemoryStore method-for-method: DP-025
// idempotent issue, DP-016 atomic cast (row lock + transaction), DP-026
// tally inputs. Every query can fail — errors propagate to the service,
// which turns them into 500s; they are never hidden as zero values.
//
// Callers must pass UUID-formatted proposal/jurisdiction/citizen refs (the
// in-memory backend accepts opaque strings; Postgres UUID columns do not).
type PGStore struct {
	pool *pgxpool.Pool
	q    *votingdb.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{pool: pool, q: votingdb.New(pool)}
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

func sessionFromRow(r votingdb.VoteSession) (*VoteSession, error) {
	var tally *TallyResult
	if len(r.TallyResult) > 0 {
		var t TallyResult
		if err := json.Unmarshal(r.TallyResult, &t); err != nil {
			return nil, err
		}
		tally = &t
	}
	return &VoteSession{
		ID:               pgconv.UUIDToString(r.ID),
		ProposalID:       pgconv.UUIDToString(r.ProposalID),
		JurisdictionID:   pgconv.UUIDToString(r.JurisdictionID),
		Method:           r.Method,
		ThresholdRule:    r.ThresholdRule,
		MinParticipation: pgconv.Float64(r.MinParticipation),
		CoolingOffUntil:  pgconv.Time(r.CoolingOffUntil),
		OpensAt:          pgconv.Time(r.OpensAt),
		ClosesAt:         pgconv.Time(r.ClosesAt),
		Status:           r.Status,
		TallyResult:      tally,
		CreatedAt:        pgconv.Time(r.CreatedAt),
	}, nil
}

func tokenFromRow(r votingdb.EligibilityToken) *EligibilityToken {
	return &EligibilityToken{
		ID:               pgconv.UUIDToString(r.ID),
		SessionID:        pgconv.UUIDToString(r.VoteSessionID),
		CitizenID:        pgconv.UUIDToString(r.CitizenID),
		BlindedTokenHash: r.BlindedTokenHash,
		IssuedAt:         pgconv.Time(r.IssuedAt),
		Used:             r.Used,
	}
}

func ballotFromRow(r votingdb.Ballot) *Ballot {
	return &Ballot{
		ID:               pgconv.UUIDToString(r.ID),
		SessionID:        pgconv.UUIDToString(r.VoteSessionID),
		TokenBlind:       r.TokenBlind,
		EncryptedChoice:  r.EncryptedChoice,
		VerificationCode: r.VerificationCode,
		CastAt:           pgconv.Time(r.CastAt),
	}
}

func (s *PGStore) CreateSession(vs *VoteSession) (*VoteSession, error) {
	ctx, cancel := opCtx()
	defer cancel()
	proposal, err := pgconv.UUIDFromString(vs.ProposalID)
	if err != nil {
		return nil, err
	}
	jurisdiction, err := pgconv.UUIDFromString(vs.JurisdictionID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.CreateVoteSession(ctx, votingdb.CreateVoteSessionParams{
		ID:               pgconv.MustUUID(newID()),
		ProposalID:       proposal,
		JurisdictionID:   jurisdiction,
		Method:           vs.Method,
		ThresholdRule:    vs.ThresholdRule,
		MinParticipation: pgconv.NumericFromFloat64(vs.MinParticipation),
		CoolingOffUntil:  pgconv.TSTZ(vs.CoolingOffUntil),
		OpensAt:          pgconv.TSTZ(vs.OpensAt),
		ClosesAt:         pgconv.TSTZ(vs.ClosesAt),
		Status:           SessionScheduled,
	})
	if err != nil {
		return nil, err
	}
	return sessionFromRow(row)
}

func (s *PGStore) GetSession(id string) (*VoteSession, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.GetVoteSession(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row)
}

func (s *PGStore) ListSessions() ([]*VoteSession, error) {
	ctx, cancel := opCtx()
	defer cancel()
	rows, err := s.q.ListVoteSessions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*VoteSession, 0, len(rows))
	for _, r := range rows {
		vs, err := sessionFromRow(r)
		if err != nil {
			return nil, err
		}
		out = append(out, vs)
	}
	return out, nil
}

func (s *PGStore) UpdateSessionStatus(id, status string) (*VoteSession, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.UpdateVoteSessionStatus(ctx, votingdb.UpdateVoteSessionStatusParams{ID: uid, Status: status})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row)
}

func (s *PGStore) SetTally(id string, tally *TallyResult) (*VoteSession, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	raw, err := json.Marshal(tally)
	if err != nil {
		return nil, err
	}
	row, err := s.q.SetVoteSessionTally(ctx, votingdb.SetVoteSessionTallyParams{ID: uid, TallyResult: raw})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row)
}

func (s *PGStore) AddOption(o *VoteOption) (*VoteOption, error) {
	ctx, cancel := opCtx()
	defer cancel()
	sessionID, err := pgconv.UUIDFromString(o.SessionID)
	if err != nil {
		return nil, err
	}
	proposalID, err := pgconv.UUIDFromString(o.ProposalID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.CreateVoteOption(ctx, votingdb.CreateVoteOptionParams{
		ID:            pgconv.MustUUID(newID()),
		VoteSessionID: sessionID,
		ProposalID:    proposalID,
		Label:         o.Label,
		Description:   o.Description,
	})
	if err != nil {
		return nil, err
	}
	return &VoteOption{
		ID:          pgconv.UUIDToString(row.ID),
		SessionID:   pgconv.UUIDToString(row.VoteSessionID),
		ProposalID:  pgconv.UUIDToString(row.ProposalID),
		Label:       row.Label,
		Description: row.Description,
	}, nil
}

func (s *PGStore) IssueToken(sessionID, citizenID string) (*EligibilityToken, error) {
	ctx, cancel := opCtx()
	defer cancel()
	sid, err := pgconv.UUIDFromString(sessionID)
	if err != nil {
		return nil, err
	}
	cid, err := pgconv.UUIDFromString(citizenID)
	if err != nil {
		return nil, err
	}
	raw := newToken()
	sum := sha256.Sum256([]byte(raw))
	row, err := s.q.InsertEligibilityToken(ctx, votingdb.InsertEligibilityTokenParams{
		ID:               pgconv.MustUUID(newID()),
		VoteSessionID:    sid,
		CitizenID:        cid,
		BlindedTokenHash: hex.EncodeToString(sum[:]),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ON CONFLICT DO NOTHING: re-issue returns the existing row
			// without the raw blind (unrecoverable by design).
			existing, gerr := s.q.GetTokenBySessionCitizen(ctx, votingdb.GetTokenBySessionCitizenParams{
				VoteSessionID: sid,
				CitizenID:     cid,
			})
			if gerr != nil {
				return nil, gerr
			}
			return tokenFromRow(existing), nil
		}
		return nil, err
	}
	t := tokenFromRow(row)
	t.TokenBlind = raw
	return t, nil
}

func (s *PGStore) CountTokens(sessionID string) (int, error) {
	ctx, cancel := opCtx()
	defer cancel()
	sid, err := pgconv.UUIDFromString(sessionID)
	if err != nil {
		return 0, err
	}
	n, err := s.q.CountSessionTokens(ctx, sid)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *PGStore) CastBallot(sessionID, tokenID, tokenBlind, encryptedChoice string) (*Ballot, *EligibilityToken, error) {
	ctx, cancel := opCtx()
	defer cancel()
	tid, err := pgconv.UUIDFromString(tokenID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)

	tok, err := qtx.LockEligibilityToken(ctx, tid)
	if err != nil {
		return nil, nil, mapNotFound(err)
	}
	if pgconv.UUIDToString(tok.VoteSessionID) != sessionID {
		return nil, nil, ErrNotFound
	}
	if tok.Used {
		return nil, nil, ErrConflict
	}
	sum := sha256.Sum256([]byte(tokenBlind))
	if hex.EncodeToString(sum[:]) != tok.BlindedTokenHash {
		return nil, nil, ErrInvalid
	}
	ballotID := newID()
	b, err := qtx.InsertBallot(ctx, votingdb.InsertBallotParams{
		ID:               pgconv.MustUUID(ballotID),
		VoteSessionID:    tok.VoteSessionID,
		TokenBlind:       tokenBlind,
		EncryptedChoice:  encryptedChoice,
		VerificationCode: newToken(),
	})
	if err != nil {
		return nil, nil, err
	}
	if err := qtx.MarkTokenUsed(ctx, tid); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	updated := tokenFromRow(tok)
	updated.Used = true
	return ballotFromRow(b), updated, nil
}

func (s *PGStore) FindBallotByVerification(code string) (*Ballot, error) {
	ctx, cancel := opCtx()
	defer cancel()
	row, err := s.q.GetBallotByVerification(ctx, code)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return ballotFromRow(row), nil
}

func (s *PGStore) BallotsForSession(sessionID string) ([]*Ballot, error) {
	ctx, cancel := opCtx()
	defer cancel()
	sid, err := pgconv.UUIDFromString(sessionID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListSessionBallots(ctx, sid)
	if err != nil {
		return nil, err
	}
	out := make([]*Ballot, 0, len(rows))
	for _, r := range rows {
		out = append(out, ballotFromRow(r))
	}
	return out, nil
}
