package main

import "testing"

func requireWinner(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("winner = nil, want %q", want)
	}
	if *got != want {
		t.Fatalf("winner = %q, want %q", *got, want)
	}
}

func TestTallyApprovalBasic(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	ballots := []string{
		"opt1,opt2",
		"opt1",
		"opt2,opt3",
		"opt1,opt3",
	}
	out := computeMethodOutcome(MethodApproval, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
	if out.Counts["opt1"] != 3 {
		t.Fatalf("opt1 count = %v, want 3", out.Counts["opt1"])
	}
	if out.Counts["opt2"] != 2 {
		t.Fatalf("opt2 count = %v, want 2", out.Counts["opt2"])
	}
}

func TestTallyApprovalTieBreaksLexicographically(t *testing.T) {
	options := []string{"optA", "optB"}
	ballots := []string{"optA", "optB"}
	out := computeMethodOutcome(MethodApproval, options, ballots)
	requireWinner(t, out.WinnerOptionID, "optA")
}

func TestTallyPreferenceScoreBasic(t *testing.T) {
	options := []string{"opt1", "opt2"}
	ballots := []string{
		"opt1:80,opt2:20",
		"opt1:60",
		"opt2:90",
	}
	out := computeMethodOutcome(MethodPreferenceScore, options, ballots)
	// opt1 avg = (80+60)/2 = 70; opt2 avg = (20+90)/2 = 55
	requireWinner(t, out.WinnerOptionID, "opt1")
	if out.Counts["opt1"] != 70 {
		t.Fatalf("opt1 avg = %v, want 70", out.Counts["opt1"])
	}
	if out.Counts["opt2"] != 55 {
		t.Fatalf("opt2 avg = %v, want 55", out.Counts["opt2"])
	}
}

func TestTallyPreferenceScoreUnscoredOptionExcludedFromAverage(t *testing.T) {
	options := []string{"opt1", "opt2"}
	ballots := []string{
		"opt1:100",
		"opt1:0,opt2:50",
	}
	out := computeMethodOutcome(MethodPreferenceScore, options, ballots)
	// opt1 avg = (100+0)/2 = 50; opt2 avg = 50/1 = 50 -> tie -> opt1 wins lexicographically
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyRankedChoiceMajorityFirstRound(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	ballots := []string{
		"opt1,opt2",
		"opt1,opt3",
		"opt1",
		"opt2,opt1",
	}
	out := computeMethodOutcome(MethodRankedChoice, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyRankedChoiceRunoffElimination(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	// Round 1: opt1=2, opt2=1, opt3=2 (total 5, no majority)
	// opt2 has fewest (1) -> eliminated
	// Round 2: opt1 gets opt2's ballot (opt2,opt1 -> opt1): opt1=3, opt3=2 -> opt1 majority (3/5 > 50%)
	ballots := []string{
		"opt1,opt3",
		"opt1,opt2",
		"opt2,opt1",
		"opt3,opt1",
		"opt3,opt2",
	}
	out := computeMethodOutcome(MethodRankedChoice, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyRankedChoiceAllTiedEliminatedSameRoundFallsBackToLastRound(t *testing.T) {
	options := []string{"opt1", "opt2"}
	// Single round: opt1=1, opt2=1, total=2, no strict majority (1 is not >1).
	// Both tied for fewest -> both eliminated -> remaining empty -> fall back
	// to this round's counts -> tie -> lexicographically smallest ("opt1").
	ballots := []string{"opt1", "opt2"}
	out := computeMethodOutcome(MethodRankedChoice, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyRankedChoiceBallotsRunOutOfChoices(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	// Ballots that rank nothing at all (blank / unknown option IDs only)
	// contribute zero votes from round one -- the algorithm must fall back
	// without panicking rather than divide by a zero total. All options tie
	// at zero -> lexicographically smallest wins.
	ballots := []string{"", "unknown-option"}
	out := computeMethodOutcome(MethodRankedChoice, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyComparativeCondorcetWinner(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	// opt1 beats opt2 and opt3 on every ballot.
	ballots := []string{
		"opt1,opt2,opt3",
		"opt1,opt3,opt2",
		"opt1,opt2",
	}
	out := computeMethodOutcome(MethodComparative, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyComparativeUnrankedTreatedAsLeastPreferred(t *testing.T) {
	options := []string{"opt1", "opt2"}
	ballots := []string{
		"opt1", // opt1 ranked, opt2 unranked -> opt1 beats opt2
		"opt1",
	}
	out := computeMethodOutcome(MethodComparative, options, ballots)
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyComparativeCycleFallsBackToCopeland(t *testing.T) {
	options := []string{"opt1", "opt2", "opt3"}
	// Rock-paper-scissors cycle: opt1>opt2, opt2>opt3, opt3>opt1, each 1-1-1 -> no Condorcet winner.
	ballots := []string{
		"opt1,opt2,opt3",
		"opt2,opt3,opt1",
		"opt3,opt1,opt2",
	}
	out := computeMethodOutcome(MethodComparative, options, ballots)
	// Perfectly symmetric cycle -> Copeland scores all equal -> lexicographically smallest.
	requireWinner(t, out.WinnerOptionID, "opt1")
}

func TestTallyEmptyBallotsDoesNotPanic(t *testing.T) {
	options := []string{"opt1", "opt2"}
	for _, m := range []VoteMethod{MethodApproval, MethodPreferenceScore, MethodRankedChoice, MethodComparative} {
		t.Run(string(m), func(t *testing.T) {
			out := computeMethodOutcome(m, options, nil)
			if out.WinnerOptionID == nil {
				t.Fatal("expected a deterministic tie-break winner even with zero ballots")
			}
		})
	}
}

func TestTallyNoOptionsReturnsNilWinner(t *testing.T) {
	out := computeMethodOutcome(MethodApproval, nil, []string{"opt1"})
	if out.WinnerOptionID != nil {
		t.Fatalf("winner = %v, want nil when there are no options", out.WinnerOptionID)
	}
}
