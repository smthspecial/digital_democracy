package auth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/digital-democracy/api-go/internal/pgconv"
	authdb "github.com/digital-democracy/api-go/internal/sqlc/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore implements Store on Postgres via the sqlc-generated queries
// (ADR-029). Refresh-reuse and MFA-failure windows stay in process memory
// (best-effort across restarts), mirroring MemoryStore.
type PGStore struct {
	pool *pgxpool.Pool
	q    *authdb.Queries

	mu                sync.Mutex
	usedRefreshHashes map[string]bool
	mfaFailures       map[string][]time.Time
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{pool: pool, q: authdb.New(pool), usedRefreshHashes: map[string]bool{}}
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

func sessionFromRow(r authdb.Session) *Session {
	return &Session{
		ID:                pgconv.UUIDToString(r.ID),
		CitizenID:         pgconv.UUIDToString(r.CitizenID),
		AccessTokenHash:   r.AccessTokenHash,
		RefreshTokenHash:  r.RefreshTokenHash,
		AccessExpiresAt:   pgconv.Time(r.AccessExpiresAt),
		DeviceFingerprint: r.DeviceFingerprint,
		IPSubnet:          r.IpSubnet,
		AssuranceTier:     r.AssuranceTier,
		LastMFAAt:         pgconv.Time(r.LastMfaAt),
		LastRefreshAt:     pgconv.Time(r.LastRefreshAt),
		ExpiresAt:         pgconv.Time(r.ExpiresAt),
		Status:            r.Status,
		CreatedAt:         pgconv.Time(r.CreatedAt),
	}
}

func factorFromRow(r authdb.MfaFactor) *MfaFactor {
	f := &MfaFactor{
		ID:                    pgconv.UUIDToString(r.ID),
		CitizenID:             pgconv.UUIDToString(r.CitizenID),
		FactorType:            r.FactorType,
		Status:                r.Status,
		TOTPSecretEnc:         pgconv.Text(r.TotpSecretEnc),
		PasskeyCredentialID:   pgconv.Text(r.PasskeyCredentialID),
		PasskeyPublicKey:      pgconv.Text(r.PasskeyPublicKey),
		BiometricEmbeddingEnc: pgconv.Text(r.BiometricEmbeddingEnc),
		EnrolledAt:            pgconv.Time(r.EnrolledAt),
		LastUsedAt:            pgconv.Time(r.LastUsedAt),
	}
	if r.RevokedAt.Valid {
		t := r.RevokedAt.Time
		f.RevokedAt = &t
	}
	return f
}

func eventFromRow(r authdb.AuthEvent) *AuthEvent {
	return &AuthEvent{
		ID:                pgconv.UUIDToString(r.ID),
		CitizenID:         pgconv.UUIDToString(r.CitizenID),
		SessionID:         pgconv.UUIDToString(r.SessionID),
		EventType:         r.EventType,
		FactorType:        pgconv.Text(r.FactorType),
		IPAddress:         pgconv.Text(r.IpAddress),
		DeviceFingerprint: pgconv.Text(r.DeviceFingerprint),
		AnomalyReason:     pgconv.Text(r.AnomalyReason),
		CreatedAt:         pgconv.Time(r.CreatedAt),
	}
}

func uuidOrNull(s string) (pgtype.UUID, error) {
	if s == "" {
		return pgtype.UUID{}, nil
	}
	return pgconv.UUIDFromString(s)
}

func (s *PGStore) InsertSession(sess *Session) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	citizen, err := pgconv.UUIDFromString(sess.CitizenID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.InsertSession(ctx, authdb.InsertSessionParams{
		ID:                pgconv.MustUUID(newID()),
		CitizenID:         citizen,
		AccessTokenHash:   sess.AccessTokenHash,
		RefreshTokenHash:  sess.RefreshTokenHash,
		AccessExpiresAt:   pgconv.TSTZ(sess.AccessExpiresAt),
		DeviceFingerprint: sess.DeviceFingerprint,
		IpSubnet:          sess.IPSubnet,
		AssuranceTier:     sess.AssuranceTier,
		LastMfaAt:         pgconv.TSTZNull(sess.LastMFAAt),
		LastRefreshAt:     pgconv.TSTZ(sess.LastRefreshAt),
		ExpiresAt:         pgconv.TSTZ(sess.ExpiresAt),
		Status:            SessionActive,
	})
	if err != nil {
		return nil, err
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) GetSession(id string) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.GetSession(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) FindByAccess(hash string) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	row, err := s.q.FindSessionByAccessHash(ctx, hash)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) FindByRefresh(hash string) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	row, err := s.q.FindSessionByRefreshHash(ctx, hash)
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) RefreshReuse(hash string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usedRefreshHashes[hash]
}

func (s *PGStore) RotateRefresh(id, newAccessHash, newRefreshHash string, accessExp, refreshedAt time.Time) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	// Retire the old hash before overwriting so replays are detectable.
	current, err := s.q.GetSession(ctx, uid)
	if err != nil {
		return nil, mapNotFound(err)
	}
	s.mu.Lock()
	s.usedRefreshHashes[current.RefreshTokenHash] = true
	s.mu.Unlock()
	row, err := s.q.RotateSessionTokens(ctx, authdb.RotateSessionTokensParams{
		ID:               uid,
		AccessTokenHash:  newAccessHash,
		RefreshTokenHash: newRefreshHash,
		AccessExpiresAt:  pgconv.TSTZ(accessExp),
		LastRefreshAt:    pgconv.TSTZ(refreshedAt),
	})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) RotateAccess(id, newAccessHash string, accessExp time.Time) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.RotateSessionAccess(ctx, authdb.RotateSessionAccessParams{
		ID:              uid,
		AccessTokenHash: newAccessHash,
		AccessExpiresAt: pgconv.TSTZ(accessExp),
	})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) SetStatus(id, status string) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.SetSessionStatus(ctx, authdb.SetSessionStatusParams{ID: uid, Status: status})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) SetTier(id, tier string, mfaAt time.Time) (*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return nil, ErrNotFound
	}
	row, err := s.q.SetSessionTier(ctx, authdb.SetSessionTierParams{
		ID:            uid,
		AssuranceTier: tier,
		LastMfaAt:     pgconv.TSTZNull(mfaAt),
	})
	if err != nil {
		return nil, mapNotFound(err)
	}
	return sessionFromRow(row), nil
}

func (s *PGStore) RevokeAll(citizenID string, now time.Time) (int, error) {
	ctx, cancel := opCtx()
	defer cancel()
	_ = now
	citizen, err := pgconv.UUIDFromString(citizenID)
	if err != nil {
		return 0, err
	}
	n, err := s.q.RevokeAllCitizenSessions(ctx, citizen)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *PGStore) SessionsOf(citizenID string) ([]*Session, error) {
	ctx, cancel := opCtx()
	defer cancel()
	citizen, err := pgconv.UUIDFromString(citizenID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.SessionsOfCitizen(ctx, citizen)
	if err != nil {
		return nil, err
	}
	out := make([]*Session, 0, len(rows))
	for _, r := range rows {
		out = append(out, sessionFromRow(r))
	}
	return out, nil
}

func (s *PGStore) PurgeExpired(now time.Time) (int, error) {
	ctx, cancel := opCtx()
	defer cancel()
	n, err := s.q.PurgeExpiredSessions(ctx, pgconv.TSTZ(now.Add(-PurgeGrace)))
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *PGStore) InsertFactor(f *MfaFactor) (*MfaFactor, error) {
	ctx, cancel := opCtx()
	defer cancel()
	citizen, err := pgconv.UUIDFromString(f.CitizenID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.InsertMfaFactor(ctx, authdb.InsertMfaFactorParams{
		ID:                    pgconv.MustUUID(newID()),
		CitizenID:             citizen,
		FactorType:            f.FactorType,
		Status:                FactorActive,
		TotpSecretEnc:         pgconv.TextNull(f.TOTPSecretEnc),
		PasskeyCredentialID:   pgconv.TextNull(f.PasskeyCredentialID),
		PasskeyPublicKey:      pgconv.TextNull(f.PasskeyPublicKey),
		BiometricEmbeddingEnc: pgconv.TextNull(f.BiometricEmbeddingEnc),
		LastUsedAt:            pgconv.TSTZNull(f.LastUsedAt),
	})
	if err != nil {
		return nil, err
	}
	return factorFromRow(row), nil
}

func (s *PGStore) ActiveFactors(citizenID string) ([]*MfaFactor, error) {
	ctx, cancel := opCtx()
	defer cancel()
	citizen, err := pgconv.UUIDFromString(citizenID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ActiveFactorsOfCitizen(ctx, citizen)
	if err != nil {
		return nil, err
	}
	out := make([]*MfaFactor, 0, len(rows))
	for _, r := range rows {
		out = append(out, factorFromRow(r))
	}
	return out, nil
}

func (s *PGStore) TouchFactor(id string, now time.Time) error {
	ctx, cancel := opCtx()
	defer cancel()
	uid, err := pgconv.UUIDFromString(id)
	if err != nil {
		return err
	}
	return s.q.TouchMfaFactor(ctx, authdb.TouchMfaFactorParams{ID: uid, LastUsedAt: pgconv.TSTZ(now)})
}

func (s *PGStore) AppendEvent(e *AuthEvent) (*AuthEvent, error) {
	ctx, cancel := opCtx()
	defer cancel()
	citizen, err := uuidOrNull(e.CitizenID)
	if err != nil {
		return nil, err
	}
	session, err := uuidOrNull(e.SessionID)
	if err != nil {
		return nil, err
	}
	row, err := s.q.InsertAuthEvent(ctx, authdb.InsertAuthEventParams{
		ID:                pgconv.MustUUID(newID()),
		CitizenID:         citizen,
		SessionID:         session,
		EventType:         e.EventType,
		FactorType:        pgconv.TextNull(e.FactorType),
		IpAddress:         pgconv.TextNull(e.IPAddress),
		DeviceFingerprint: pgconv.TextNull(e.DeviceFingerprint),
		AnomalyReason:     pgconv.TextNull(e.AnomalyReason),
	})
	if err != nil {
		return nil, err
	}
	return eventFromRow(row), nil
}

func (s *PGStore) ListEvents(citizenID string) ([]*AuthEvent, error) {
	ctx, cancel := opCtx()
	defer cancel()
	var rows []authdb.AuthEvent
	var err error
	if citizenID == "" {
		rows, err = s.q.ListAuthEvents(ctx)
	} else {
		citizen, perr := pgconv.UUIDFromString(citizenID)
		if perr != nil {
			return nil, perr
		}
		rows, err = s.q.ListCitizenAuthEvents(ctx, citizen)
	}
	if err != nil {
		return nil, err
	}
	out := make([]*AuthEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, eventFromRow(r))
	}
	return out, nil
}

func (s *PGStore) RecordMFAFailure(sessionID string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := now.Add(-MFAFailureWindow)
	kept := s.mfaFailures[sessionID][:0]
	for _, t := range s.mfaFailures[sessionID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	s.mfaFailures[sessionID] = kept
	return len(kept) >= MaxMFAFailures
}
