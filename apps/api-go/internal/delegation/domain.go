// Package delegation implements delegation-service (SRV-010).
//
// Responsibility per .spec/technical/services/srv-010.md: voluntary,
// issue-specific, revocable, auto-expiring vote delegations (liquid
// democracy, ADR-008). Resolves delegation chains for the voting pipeline
// (DP-041). Delegation is publicly visible; competency validation arrives
// over the CompetencyChecker seam.
package delegation

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

// Delegation is TBL-023. Revocation sets RevokedAt; rows are never deleted
// (audit trail, DP-015). Expiry is mandatory (FR-057).
type Delegation struct {
	ID          string     `json:"id"`
	DelegatorID string     `json:"delegator_id"`
	DelegateID  string     `json:"delegate_id"`
	DomainID    string     `json:"domain_id"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
}

// Active reports whether the delegation currently conveys voting power.
func (d *Delegation) Active(now time.Time) bool {
	return d.RevokedAt == nil && d.ExpiresAt.After(now)
}

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
	ErrInvalid  = errors.New("invalid request")
)

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	// Dashed UUID format: matches the UUID columns in db/migrations.
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
