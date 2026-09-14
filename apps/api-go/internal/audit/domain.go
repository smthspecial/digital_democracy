// Package audit implements audit-service (SRV-012).
//
// Responsibility per .spec/technical/services/srv-012.md: the append-only
// hash-chained audit log (ADR-005), constitutional rights registry, and
// constitutional review gate (DP-034). Every service writes here; nothing
// writes back. Ballot content must never enter the log (NFR-001).
package audit

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

// Action types (TBL-034.action_type).
const (
	ActionProposalCreated       = "proposal_created"
	ActionProposalStatusChanged = "proposal_status_changed"
	ActionVoteCertified         = "vote_certified"
	ActionSystemUpdate          = "system_update"
	ActionRuleChange            = "rule_change"
	ActionAdminAction           = "admin_action"
	ActionIdentityEvent         = "identity_event"
)

// Vote-lifecycle events emitted by voting-service map onto the TBL-034 enum:
// vote_session_scheduled/opened/closed → proposal_status_changed scope is
// proposal-only, so session transitions use vote_certified for the terminal
// certification and system_update for intermediate transitions; ballot_cast
// is deliberately NOT logged per-entry (only session-level events, SRV-012
// key rules) — the emitter sends vote_session_opened etc. and Append maps
// unknown session verbs to system_update rather than dropping history.
var actionAliases = map[string]string{
	"vote_session_scheduled": "system_update",
	"vote_session_opened":    "system_update",
	"vote_session_closed":    "system_update",
	"vote_certified":         "vote_certified",
	"vote_quorum_failed":     "system_update",
	"ballot_cast":            "system_update",
	"delegation_created":     "admin_action",
	"delegation_revoked":     "admin_action",
	"delegation_expired":     "admin_action",
}

// Review results (TBL-036.result).
const (
	ReviewCleared = "cleared"
	ReviewBlocked = "blocked"
)

// GenesisPrevHash anchors the first chain link.
const GenesisPrevHash = "GENESIS"

// AuditEntry is TBL-034. IdempotencyKey carries the source event id for
// at-least-once dedupe (DP-036, ADR-023); empty on direct HTTP appends.
type AuditEntry struct {
	ID             string    `json:"id"`
	ActionType     string    `json:"action_type"`
	ActorRef       string    `json:"actor_ref"`
	PayloadHash    string    `json:"payload_hash"`
	PrevHash       string    `json:"prev_hash"`
	Hash           string    `json:"hash"`
	Signature      string    `json:"signature"`
	IdempotencyKey string    `json:"idempotency_key,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// ConstitutionalRight is TBL-035.
type ConstitutionalRight struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Protected   bool   `json:"protected"`
}

// ConstitutionalReview is TBL-036.
type ConstitutionalReview struct {
	ID          string    `json:"id"`
	ProposalID  string    `json:"proposal_id"`
	RightID     string    `json:"right_id"`
	Result      string    `json:"result"`
	ReviewerRef string    `json:"reviewer_ref"`
	CreatedAt   time.Time `json:"created_at"`
}

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid request")
	ErrConflict = errors.New("conflict")
)

// InvalidStateError reports a state-machine violation with the reason
// attached (e.g. which DP-043 gate condition is unmet). Handlers map it to
// 422 via errors.As; it never matches the sentinels above.
type InvalidStateError struct{ Reason string }

func (e *InvalidStateError) Error() string { return "invalid state: " + e.Reason }

// ErrInvalidState builds the 422-class state error.
func ErrInvalidState(reason string) error { return &InvalidStateError{Reason: reason} }

// Protocol change states (DP-043): pending until all approvals exist and
// the delay elapsed; released exactly once.
const (
	ChangePending  = "pending"
	ChangeReleased = "released"
)

// ProtocolApproval records one independent approval of a protocol change
// (DP-035 approval refs resolved by governance-role-service; audit tracks the
// refs, not the approval logic).
type ProtocolApproval struct {
	Ref         string    `json:"ref"`
	ApproverRef string    `json:"approver_ref"`
	At          time.Time `json:"at"`
}

// ProtocolChange is the DP-043 gate state: a protocol change (voting logic,
// identity rules, jurisdiction logic, lifecycle rules) that may execute only
// after audit-service confirms approvals, delay, and public visibility.
type ProtocolChange struct {
	ID                string             `json:"id"`
	ChangeRef         string             `json:"change_ref"`
	RequiredApprovals []string           `json:"required_approval_refs"`
	Approvals         []ProtocolApproval `json:"approvals"`
	DelayUntil        time.Time          `json:"delay_until"`
	VisibleSince      time.Time          `json:"visible_since"`
	Status            string             `json:"status"`
	CreatedAt         time.Time          `json:"created_at"`
	ReleasedAt        *time.Time         `json:"released_at,omitempty"`
}

func validAction(a string) bool {
	switch a {
	case ActionProposalCreated, ActionProposalStatusChanged, ActionVoteCertified,
		ActionSystemUpdate, ActionRuleChange, ActionAdminAction, ActionIdentityEvent:
		return true
	}
	return false
}

// normalizeAction maps emitter verbs onto the TBL-034 enum. Unknown verbs
// are rejected (second return false) — callers decide ack-drop vs error.
func normalizeAction(verb string) (string, bool) {
	if validAction(verb) {
		return verb, true
	}
	if mapped, ok := actionAliases[verb]; ok {
		return mapped, true
	}
	return "", false
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	// Dashed UUID format: matches the UUID columns in db/migrations.
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// chainHash binds an entry to its predecessor (ADR-005 tamper evidence).
func chainHash(prevHash, payloadHash, actionType, actorRef string) string {
	return sha256Hex(prevHash + "\n" + payloadHash + "\n" + actionType + "\n" + actorRef)
}
