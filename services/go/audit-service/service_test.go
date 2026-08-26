package main

import "testing"

func TestServiceAppendAndListLog(t *testing.T) {
	svc := NewService(NewStore())

	entry, err := svc.Append(ActionAdminAction, "role:election-admin", map[string]any{"detail": "x"}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry.ID == "" {
		t.Fatalf("expected a generated id")
	}

	entries := svc.ListLog("")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
}

func TestServiceCreateAndListRights(t *testing.T) {
	svc := NewService(NewStore())

	right, err := svc.CreateRight("freedom of speech", "protects expression", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if right.ID == "" {
		t.Fatalf("expected a generated id")
	}

	rights := svc.ListRights()
	if len(rights) != 1 {
		t.Fatalf("expected 1 right, got %d", len(rights))
	}
}

func TestServiceCreateRightRejectsEmptyName(t *testing.T) {
	svc := NewService(NewStore())
	_, err := svc.CreateRight("", "desc", true)
	if !isDomainErrKind(err, KindValidation) {
		t.Fatalf("expected validation error, got %v", err)
	}
}

// fakeAssessor lets tests control exactly which rights get flagged without
// depending on the default keyword-match implementation.
type fakeAssessor struct {
	blockedRightIDs map[string]bool
}

func (f fakeAssessor) Assess(right ConstitutionalRight, changeSummary string) bool {
	return f.blockedRightIDs[right.ID]
}

func TestServiceReviewProposalClearedWhenNoRightsAffected(t *testing.T) {
	svc := NewService(NewStore())
	svc.assessor = fakeAssessor{blockedRightIDs: map[string]bool{}}

	r1, err := svc.CreateRight("freedom of speech", "d", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := svc.CreateRight("unprotected right", "d", false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	reviews, blocked, err := svc.ReviewProposal("proposal-1", "increases tax rate")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if blocked {
		t.Fatalf("expected proposal to clear")
	}
	if len(reviews) != 1 {
		t.Fatalf("expected exactly one review row (one protected right), got %d", len(reviews))
	}
	if reviews[0].RightID != r1.ID || reviews[0].Result != ResultCleared {
		t.Fatalf("expected cleared review for protected right, got %+v", reviews[0])
	}

	logEntries := svc.ListLog("")
	if len(logEntries) != 1 {
		t.Fatalf("expected the review to append exactly one audit log entry, got %d", len(logEntries))
	}
}

func TestServiceReviewProposalBlockedWhenAnyRightAffected(t *testing.T) {
	svc := NewService(NewStore())

	r1, err := svc.CreateRight("freedom of speech", "d", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r2, err := svc.CreateRight("due process", "d", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	svc.assessor = fakeAssessor{blockedRightIDs: map[string]bool{r2.ID: true}}

	reviews, blocked, err := svc.ReviewProposal("proposal-1", "restricts due process")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !blocked {
		t.Fatalf("expected proposal to be blocked")
	}
	if len(reviews) != 2 {
		t.Fatalf("expected one review row per protected right, got %d", len(reviews))
	}

	results := map[string]ReviewResult{}
	for _, r := range reviews {
		results[r.RightID] = r.Result
	}
	if results[r1.ID] != ResultCleared {
		t.Fatalf("expected right 1 cleared, got %q", results[r1.ID])
	}
	if results[r2.ID] != ResultBlocked {
		t.Fatalf("expected right 2 blocked, got %q", results[r2.ID])
	}

	logEntries := svc.ListLog("")
	if len(logEntries) != 2 {
		t.Fatalf("expected two audit log entries (one per review row), got %d", len(logEntries))
	}
}

func TestServiceReviewProposalDefaultAssessorKeywordMatch(t *testing.T) {
	svc := NewService(NewStore())
	if _, err := svc.CreateRight("freedom of speech", "d", true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	_, blocked, err := svc.ReviewProposal("proposal-1", "This proposal limits Freedom of Speech in public forums")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !blocked {
		t.Fatalf("expected default keyword-match assessor to block on matching right name")
	}

	_, blocked2, err := svc.ReviewProposal("proposal-2", "This proposal funds a new bridge")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if blocked2 {
		t.Fatalf("expected default keyword-match assessor to clear on non-matching change summary")
	}
}

func TestServiceGateProtocolExecutionReleasesWhenAllConditionsMet(t *testing.T) {
	svc := NewService(NewStore())

	released, reason, err := svc.GateProtocolExecution(
		[]string{"technical_committee", "ethics_board"},
		[]string{"ethics_board", "technical_committee"},
		true, true,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !released {
		t.Fatalf("expected release, got reason %q", reason)
	}

	logEntries := svc.ListLog("")
	if len(logEntries) != 1 {
		t.Fatalf("expected release to append one audit log entry, got %d", len(logEntries))
	}
}

func TestServiceGateProtocolExecutionBlocksOnMissingApproval(t *testing.T) {
	svc := NewService(NewStore())

	released, reason, err := svc.GateProtocolExecution(
		[]string{"technical_committee", "ethics_board"},
		[]string{"technical_committee"},
		true, true,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if released {
		t.Fatalf("expected no release when an approval is missing")
	}
	if reason == "" {
		t.Fatalf("expected a non-empty reason")
	}

	logEntries := svc.ListLog("")
	if len(logEntries) != 0 {
		t.Fatalf("expected no audit entry when not released, got %d", len(logEntries))
	}
}

func TestServiceGateProtocolExecutionBlocksOnDelayOrVisibility(t *testing.T) {
	cases := []struct {
		name            string
		delayElapsed    bool
		publiclyVisible bool
	}{
		{"delay not elapsed", false, true},
		{"not publicly visible", true, false},
		{"neither", false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewService(NewStore())
			released, reason, err := svc.GateProtocolExecution([]string{"a"}, []string{"a"}, tc.delayElapsed, tc.publiclyVisible)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if released {
				t.Fatalf("expected no release")
			}
			if reason == "" {
				t.Fatalf("expected a non-empty reason")
			}
		})
	}
}
