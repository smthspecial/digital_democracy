package auth

import (
	"bytes"
	"encoding/json"
	"time"
)

type Ceremony struct {
	CitizenID string
	Kind      string
	Payload   json.RawMessage
	ExpiresAt time.Time
}

func (st *MemoryStore) InsertPasskey(f *MfaFactor, credential json.RawMessage) (*MfaFactor, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, existing := range st.factors {
		if existing.FactorType == FactorPasskey && (existing.PasskeyCredentialID == f.PasskeyCredentialID || existing.CitizenID == f.CitizenID && existing.Status == FactorActive) {
			return nil, ErrForbidden
		}
	}
	f.ID = newID()
	f.EnrolledAt = time.Now().UTC()
	st.factors[f.ID] = f
	st.factorsByCitizen[f.CitizenID] = append(st.factorsByCitizen[f.CitizenID], f.ID)
	st.credentials[f.ID] = append(json.RawMessage(nil), credential...)
	out := *f
	return &out, nil
}

func (st *PGStore) InsertPasskey(f *MfaFactor, credential json.RawMessage) (*MfaFactor, error) {
	ctx, cancel := opCtx()
	defer cancel()
	f.ID = newID()
	f.EnrolledAt = time.Now().UTC()
	_, err := st.pool.Exec(ctx, `INSERT INTO mfa_factor (id,citizen_id,factor_type,status,passkey_credential_id,webauthn_credential,enrolled_at,last_used_at) VALUES ($1,$2,'passkey','active',$3,$4,$5,$6)`, f.ID, f.CitizenID, f.PasskeyCredentialID, credential, f.EnrolledAt, f.LastUsedAt)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (st *MemoryStore) InsertCeremony(hash string, c Ceremony) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	for key, value := range st.ceremonies {
		if !value.ExpiresAt.After(time.Now()) {
			delete(st.ceremonies, key)
		}
	}
	st.ceremonies[hash] = c
	return nil
}

func (st *MemoryStore) ConsumeCeremony(hash, kind string, now time.Time) (*Ceremony, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	c, ok := st.ceremonies[hash]
	if !ok || c.Kind != kind || !c.ExpiresAt.After(now) {
		return nil, ErrUnauthorized
	}
	delete(st.ceremonies, hash)
	return &c, nil
}

func (st *MemoryStore) SaveWebAuthnCredential(factorID string, credential, previous json.RawMessage) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.factors[factorID] == nil {
		return ErrNotFound
	}
	if !bytes.Equal(st.credentials[factorID], previous) {
		return ErrUnauthorized
	}
	st.credentials[factorID] = append(json.RawMessage(nil), credential...)
	return nil
}

func (st *MemoryStore) WebAuthnCredential(factorID string) (json.RawMessage, error) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	data, ok := st.credentials[factorID]
	if !ok {
		return nil, ErrNotFound
	}
	return append(json.RawMessage(nil), data...), nil
}

func (st *PGStore) InsertCeremony(hash string, c Ceremony) error {
	ctx, cancel := opCtx()
	defer cancel()
	_, err := st.pool.Exec(ctx, `INSERT INTO auth_ceremony (token_hash,citizen_id,kind,payload,expires_at) VALUES ($1,$2,$3,$4,$5)`, hash, c.CitizenID, c.Kind, c.Payload, c.ExpiresAt)
	return err
}

func (st *PGStore) ConsumeCeremony(hash, kind string, now time.Time) (*Ceremony, error) {
	ctx, cancel := opCtx()
	defer cancel()
	var c Ceremony
	err := st.pool.QueryRow(ctx, `DELETE FROM auth_ceremony WHERE token_hash=$1 AND kind=$2 AND expires_at>$3 RETURNING citizen_id::text,kind,payload,expires_at`, hash, kind, now).Scan(&c.CitizenID, &c.Kind, &c.Payload, &c.ExpiresAt)
	if err != nil {
		return nil, ErrUnauthorized
	}
	return &c, nil
}

func (st *PGStore) SaveWebAuthnCredential(factorID string, credential, previous json.RawMessage) error {
	ctx, cancel := opCtx()
	defer cancel()
	result, err := st.pool.Exec(ctx, `UPDATE mfa_factor SET webauthn_credential=$2 WHERE id=$1 AND factor_type='passkey' AND status='active' AND webauthn_credential=$3::jsonb`, factorID, credential, previous)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (st *PGStore) WebAuthnCredential(factorID string) (json.RawMessage, error) {
	ctx, cancel := opCtx()
	defer cancel()
	var data json.RawMessage
	err := st.pool.QueryRow(ctx, `SELECT webauthn_credential FROM mfa_factor WHERE id=$1 AND webauthn_credential IS NOT NULL`, factorID).Scan(&data)
	return data, mapNotFound(err)
}
