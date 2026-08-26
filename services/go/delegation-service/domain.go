// Domain types for SRV-010 delegation-service: liquid-democracy delegations
// (TBL-023, .spec/technical/database/tbl-023.md).
package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"time"
)

type Delegation struct {
	ID          string     `json:"id"`
	DelegatorID string     `json:"delegator_id"`
	DelegateID  string     `json:"delegate_id"`
	DomainID    string     `json:"domain_id"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
}

// activeAt implements DP-041's activity rule: not yet expired and not
// revoked as of the given instant (revoked_at set in the future doesn't
// count as revoked yet).
func (d *Delegation) activeAt(at time.Time) bool {
	if d.RevokedAt != nil && !d.RevokedAt.After(at) {
		return false
	}
	return d.ExpiresAt.After(at)
}

type ListFilter struct {
	DelegatorID string
	DelegateID  string
	DomainID    string
}

var (
	ErrValidation         = errors.New("validation failed")
	ErrSelfDelegation     = errors.New("delegator and delegate must differ")
	ErrExpiryNotFuture    = errors.New("expires_at must be strictly in the future")
	ErrNoCompetency       = errors.New("delegate lacks active competency in domain")
	ErrCircularDelegation = errors.New("delegation would create a circular chain")
	ErrDelegationNotFound = errors.New("delegation not found")
	ErrNotDelegator       = errors.New("only the delegator may revoke this delegation")
	ErrAlreadyRevoked     = errors.New("delegation already revoked")
)

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("newID: reading random bytes: %w", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
