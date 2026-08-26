package main

import (
	"fmt"
	"strings"
	"time"
)

// RightImpactAssessor decides whether a proposed change affects a
// constitutional right. Real constitutional review is ultimately an
// elevated human review process (AUTH-007); this interface is the seam
// where that eventually plugs in. The default implementation below is a
// placeholder trigger only.
type RightImpactAssessor interface {
	Assess(right ConstitutionalRight, changeSummary string) bool
}

// keywordMatchAssessor blocks a right if its name appears in the change
// summary, case-insensitively.
type keywordMatchAssessor struct{}

func (keywordMatchAssessor) Assess(right ConstitutionalRight, changeSummary string) bool {
	return strings.Contains(strings.ToLower(changeSummary), strings.ToLower(right.Name))
}

const (
	reviewerRef          = "audit-service:constitutional-review-engine"
	protocolGateActorRef = "audit-service:protocol-change-gate"
)

type Service struct {
	store    *Store
	assessor RightImpactAssessor
}

func NewService(store *Store) *Service {
	return &Service{store: store, assessor: keywordMatchAssessor{}}
}

func (s *Service) Append(actionType ActionType, actorRef string, payload any, idempotencyKey string) (*AuditLogEntry, error) {
	return s.store.Append(actionType, actorRef, payload, idempotencyKey)
}

func (s *Service) ListLog(filter ActionType) []AuditLogEntry {
	return s.store.ListLog(filter)
}

func (s *Service) VerifyChainIntegrity() (bool, string, error) {
	return s.store.VerifyChainIntegrity()
}

func (s *Service) CreateRight(name, description string, protected bool) (*ConstitutionalRight, error) {
	return s.store.CreateRight(name, description, protected)
}

func (s *Service) ListRights() []ConstitutionalRight {
	return s.store.ListRights()
}

// ReviewProposal is DP-034: for every protected constitutional right, write
// one review row (cleared or blocked) and audit-log the decision (DP-036).
// Any blocked right blocks the whole proposal.
func (s *Service) ReviewProposal(proposalID, changeSummary string) ([]ConstitutionalReview, bool, error) {
	if proposalID == "" {
		return nil, false, validationError("proposal_id is required")
	}

	protectedRights := s.store.ProtectedRights()
	reviews := make([]ConstitutionalReview, 0, len(protectedRights))
	blocked := false

	for _, right := range protectedRights {
		result := ResultCleared
		if s.assessor.Assess(right, changeSummary) {
			result = ResultBlocked
			blocked = true
		}

		review := ConstitutionalReview{
			ID:          generateID(),
			ProposalID:  proposalID,
			RightID:     right.ID,
			Result:      result,
			ReviewerRef: reviewerRef,
			CreatedAt:   time.Now().UTC(),
		}
		s.store.recordReview(review)
		reviews = append(reviews, review)

		payload := map[string]any{
			"proposal_id": proposalID,
			"right_id":    right.ID,
			"result":      result,
		}
		if _, err := s.store.Append(ActionRuleChange, reviewerRef, payload, ""); err != nil {
			return nil, false, err
		}
	}

	return reviews, blocked, nil
}

// GateProtocolExecution is DP-043: releases a protocol change's execution
// signal only once every required approval type is present, the delay has
// elapsed, and the change was publicly visible throughout. Inputs are
// caller-supplied each call rather than a persisted table -- there is
// nothing else for this gate to own.
func (s *Service) GateProtocolExecution(requiredApprovalTypes, obtainedApprovalTypes []string, delayElapsed, publiclyVisible bool) (bool, string, error) {
	obtained := make(map[string]bool, len(obtainedApprovalTypes))
	for _, a := range obtainedApprovalTypes {
		obtained[a] = true
	}

	var missing []string
	for _, required := range requiredApprovalTypes {
		if !obtained[required] {
			missing = append(missing, required)
		}
	}

	var reasons []string
	if len(missing) > 0 {
		reasons = append(reasons, fmt.Sprintf("missing approvals: %s", strings.Join(missing, ", ")))
	}
	if !delayElapsed {
		reasons = append(reasons, "delay period has not elapsed")
	}
	if !publiclyVisible {
		reasons = append(reasons, "change has not been publicly visible")
	}

	if len(reasons) > 0 {
		return false, strings.Join(reasons, "; "), nil
	}

	payload := map[string]any{
		"required_approval_types": requiredApprovalTypes,
		"obtained_approval_types": obtainedApprovalTypes,
		"delay_elapsed":           delayElapsed,
		"publicly_visible":        publiclyVisible,
	}
	if _, err := s.store.Append(ActionRuleChange, protocolGateActorRef, payload, ""); err != nil {
		return false, "", err
	}

	return true, "", nil
}
