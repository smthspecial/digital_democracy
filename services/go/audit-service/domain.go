package main

import "time"

// ActionType enumerates the kinds of governance-relevant events the audit
// log records (TBL-034.action_type).
type ActionType string

const (
	ActionProposalCreated ActionType = "proposal_created"
	ActionVoteCertified   ActionType = "vote_certified"
	ActionSystemUpdate    ActionType = "system_update"
	ActionRuleChange      ActionType = "rule_change"
	ActionAdminAction     ActionType = "admin_action"
	ActionIdentityEvent   ActionType = "identity_event"
)

func (a ActionType) Valid() bool {
	switch a {
	case ActionProposalCreated, ActionVoteCertified, ActionSystemUpdate,
		ActionRuleChange, ActionAdminAction, ActionIdentityEvent:
		return true
	default:
		return false
	}
}

// AuditLogEntry is a row of TBL-034. Ballot content is never stored here
// (NFR-001) -- only a hash of whatever payload the caller submitted.
type AuditLogEntry struct {
	ID          string     `json:"id"`
	ActionType  ActionType `json:"action_type"`
	ActorRef    string     `json:"actor_ref"`
	PayloadHash string     `json:"payload_hash"`
	PrevHash    string     `json:"prev_hash"`
	Signature   string     `json:"signature"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ConstitutionalRight is a row of TBL-035.
type ConstitutionalRight struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Protected   bool   `json:"protected"`
}

// ReviewResult enumerates TBL-036.result.
type ReviewResult string

const (
	ResultCleared ReviewResult = "cleared"
	ResultBlocked ReviewResult = "blocked"
)

// ConstitutionalReview is a row of TBL-036.
type ConstitutionalReview struct {
	ID          string       `json:"id"`
	ProposalID  string       `json:"proposal_id"`
	RightID     string       `json:"right_id"`
	Result      ReviewResult `json:"result"`
	ReviewerRef string       `json:"reviewer_ref"`
	CreatedAt   time.Time    `json:"created_at"`
}

// ErrorKind classifies a domain failure so the handler layer can translate
// it to the right HTTP status without parsing error strings.
type ErrorKind string

const (
	KindValidation ErrorKind = "validation"
	KindNotFound   ErrorKind = "not_found"
	KindConflict   ErrorKind = "conflict"
)

type DomainError struct {
	Kind    ErrorKind
	Message string
}

func (e *DomainError) Error() string { return e.Message }

func validationError(msg string) error { return &DomainError{Kind: KindValidation, Message: msg} }
