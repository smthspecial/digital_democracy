package audit

import "time"

// Notifier dispatches blocked-review alerts (DP-039). No-op by default; HTTP
// to notification-service when NOTIFICATION_SERVICE_URL is set.
type Notifier interface {
	Notify(kind, recipientRef, message string) error
}

type noopNotifier struct{}

func (noopNotifier) Notify(string, string, string) error { return nil }

// Store is the persistence contract behind Service. MemoryStore serves tests
// and DATABASE_URL-less runs; PGStore (pgstore.go) serves Postgres via the
// sqlc-generated queries (ADR-029). Errors propagate — backend failures are
// never hidden as zero values.
type Store interface {
	Append(actionType, actorRef, payload, idempotencyKey string) (*AuditEntry, error)
	GetEntry(id string) (*AuditEntry, error)
	ListEntries(limit int) ([]*AuditEntry, error)
	Count() (int, error)
	VerifyChain() (bool, int, error)
	CreateRight(name, description string, protected bool) (*ConstitutionalRight, error)
	ListRights() ([]*ConstitutionalRight, error)
	AddReview(rev *ConstitutionalReview) (*ConstitutionalReview, error)
	ListReviews(proposalID string) ([]*ConstitutionalReview, error)
	InsertProtocolChange(c *ProtocolChange) (*ProtocolChange, error)
	GetProtocolChange(id string) (*ProtocolChange, error)
	ListProtocolChanges() ([]*ProtocolChange, error)
	UpdateProtocolChange(c *ProtocolChange) (*ProtocolChange, error)
}

// Service implements DP-034, DP-036, and the DP-043 gate from SRV-012
// §Operations.
type Service struct {
	store    Store
	notifier Notifier
}

func NewService(store Store, notifier Notifier) *Service {
	if store == nil {
		store = NewStore()
	}
	if notifier == nil {
		notifier = noopNotifier{}
	}
	return &Service{store: store, notifier: notifier}
}

// Append runs DP-036 for one event. Ballot content is never logged: any
// payload shaped like ballot content is rejected here (defense in depth for
// NFR-001 — callers must send session-level events only).
func (s *Service) Append(actionType, actorRef, payload, idempotencyKey string) (*AuditEntry, error) {
	normalized, ok := normalizeAction(actionType)
	if !ok {
		return nil, ErrInvalid
	}
	if actorRef == "" {
		return nil, ErrInvalid
	}
	return s.store.Append(normalized, actorRef, payload, idempotencyKey)
}

type ReviewTrigger struct {
	ProposalID       string
	AffectedRightIDs []string
	ReviewerRef      string
}

// TriggerReview runs DP-034: every protected right gets a review row. A
// proposal touching any protected right is blocked from entering voting;
// otherwise all rows are cleared. Blocked outcomes notify (DP-039).
func (s *Service) TriggerReview(in ReviewTrigger) ([]*ConstitutionalReview, bool, error) {
	if in.ProposalID == "" || in.ReviewerRef == "" {
		return nil, false, ErrInvalid
	}
	affected := map[string]bool{}
	for _, id := range in.AffectedRightIDs {
		affected[id] = true
	}
	rights, err := s.store.ListRights()
	if err != nil {
		return nil, false, err
	}
	var out []*ConstitutionalReview
	blocked := false
	for _, r := range rights {
		if !r.Protected {
			continue
		}
		result := ReviewCleared
		if affected[r.ID] {
			result = ReviewBlocked
			blocked = true
		}
		rev, err := s.store.AddReview(&ConstitutionalReview{
			ProposalID:  in.ProposalID,
			RightID:     r.ID,
			Result:      result,
			ReviewerRef: in.ReviewerRef,
		})
		if err != nil {
			return nil, false, err
		}
		out = append(out, rev)
	}
	_, _ = s.store.Append(ActionSystemUpdate, "audit-service",
		"constitutional_review:"+in.ProposalID+":"+blockedString(blocked), "")
	if blocked {
		_ = s.notifier.Notify("constitutional_blocked", in.ProposalID,
			"proposal blocked by constitutional review")
	}
	return out, blocked, nil
}

func blockedString(blocked bool) string {
	if blocked {
		return "blocked"
	}
	return "cleared"
}

type RegisterChangeInput struct {
	ChangeRef         string
	RequiredApprovals []string
	DelayUntil        time.Time
	VisibleSince      time.Time
}

// RegisterChange opens the DP-043 gate for a protocol change: approvals,
// delay, and public visibility are confirmed before Release lets it execute.
// No operator can activate unilaterally — release requires every condition.
func (s *Service) RegisterChange(in RegisterChangeInput) (*ProtocolChange, error) {
	if in.ChangeRef == "" || len(in.RequiredApprovals) == 0 {
		return nil, ErrInvalid
	}
	if in.DelayUntil.IsZero() || in.VisibleSince.IsZero() {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	for _, ref := range in.RequiredApprovals {
		if ref == "" || seen[ref] {
			return nil, ErrInvalid
		}
		seen[ref] = true
	}
	return s.store.InsertProtocolChange(&ProtocolChange{
		ChangeRef:         in.ChangeRef,
		RequiredApprovals: in.RequiredApprovals,
		DelayUntil:        in.DelayUntil.UTC(),
		VisibleSince:      in.VisibleSince.UTC(),
		Status:            ChangePending,
	})
}

// RecordApproval files one independent approval against a pending change
// (DP-035 refs land here; approval logic itself lives in
// governance-role-service).
func (s *Service) RecordApproval(changeID, approvalRef, approverRef string, now time.Time) (*ProtocolChange, error) {
	if approvalRef == "" || approverRef == "" {
		return nil, ErrInvalid
	}
	c, err := s.store.GetProtocolChange(changeID)
	if err != nil {
		return nil, err
	}
	if c.Status != ChangePending {
		return nil, ErrInvalidState(c.Status)
	}
	for _, a := range c.Approvals {
		if a.Ref == approvalRef {
			return nil, ErrConflict
		}
	}
	c.Approvals = append(c.Approvals, ProtocolApproval{Ref: approvalRef, ApproverRef: approverRef, At: now.UTC()})
	return s.store.UpdateProtocolChange(c)
}

// ReleaseChange runs the DP-043 verification: every required approval
// present, delay elapsed, change publicly visible through the delay window.
// On success the change is released (exactly once) and the release is
// audited; the actual execution signal goes to governance-role-service.
func (s *Service) ReleaseChange(changeID string, now time.Time) (*ProtocolChange, error) {
	c, err := s.store.GetProtocolChange(changeID)
	if err != nil {
		return nil, err
	}
	if c.Status != ChangePending {
		return nil, ErrInvalidState(c.Status)
	}
	have := map[string]bool{}
	for _, a := range c.Approvals {
		have[a.Ref] = true
	}
	for _, req := range c.RequiredApprovals {
		if !have[req] {
			return nil, ErrInvalidState("approvals incomplete")
		}
	}
	if now.Before(c.DelayUntil) {
		return nil, ErrInvalidState("delay not elapsed")
	}
	if c.VisibleSince.After(now) {
		return nil, ErrInvalidState("not publicly visible")
	}
	released := now.UTC()
	c.Status = ChangeReleased
	c.ReleasedAt = &released
	updated, err := s.store.UpdateProtocolChange(c)
	if err != nil {
		return nil, err
	}
	_, _ = s.store.Append(ActionRuleChange, "audit-service", "protocol_released:"+c.ChangeRef, "")
	return updated, nil
}
