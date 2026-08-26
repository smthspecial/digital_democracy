package main

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// methodOutcome is the raw tally output of one voting method, before the
// threshold_rule's extra eligibility check (see supermajorityShare below)
// is applied by the caller.
type methodOutcome struct {
	Counts         map[string]float64
	WinnerOptionID *string
	// WinnerShare is the winner's share of the "final determination" on a
	// [0,1] scale, used only for threshold_rule=supermajority. Its exact
	// meaning is method-specific (documented per branch below) since the
	// spec's "winner's count / total ballots counted" formula does not map
	// onto every method's counts in the same units.
	WinnerShare float64
}

// computeMethodOutcome tallies plainChoices (one decrypted ballot per
// entry) against optionIDs per the given method's ballot-format contract.
func computeMethodOutcome(method VoteMethod, optionIDs []string, plainChoices []string) methodOutcome {
	if len(optionIDs) == 0 {
		return methodOutcome{Counts: map[string]float64{}}
	}
	switch method {
	case MethodApproval:
		return tallyApproval(optionIDs, plainChoices)
	case MethodPreferenceScore:
		return tallyPreferenceScore(optionIDs, plainChoices)
	case MethodRankedChoice:
		return tallyRankedChoice(optionIDs, parseRankings(plainChoices, optionIDs))
	case MethodComparative:
		return tallyComparative(optionIDs, parseRankings(plainChoices, optionIDs))
	default:
		return methodOutcome{Counts: map[string]float64{}}
	}
}

// pickMaxByCount returns the id with the highest count, ties broken by
// lexicographically smallest id. ids need not be pre-sorted.
func pickMaxByCount(counts map[string]float64) string {
	ids := sortedKeys(counts)
	winner := ids[0]
	best := counts[winner]
	for _, id := range ids[1:] {
		if counts[id] > best {
			winner = id
			best = counts[id]
		}
	}
	return winner
}

func sortedKeys(counts map[string]float64) []string {
	ids := make([]string, 0, len(counts))
	for id := range counts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func tallyApproval(optionIDs []string, ballots []string) methodOutcome {
	counts := zeroCounts(optionIDs)
	for _, choice := range ballots {
		for _, optID := range strings.Split(choice, ",") {
			optID = strings.TrimSpace(optID)
			if _, ok := counts[optID]; ok {
				counts[optID]++
			}
		}
	}
	winner := pickMaxByCount(counts)
	share := 0.0
	if len(ballots) > 0 {
		share = counts[winner] / float64(len(ballots))
	}
	w := winner
	return methodOutcome{Counts: counts, WinnerOptionID: &w, WinnerShare: share}
}

func tallyPreferenceScore(optionIDs []string, ballots []string) methodOutcome {
	sums := zeroCounts(optionIDs)
	scoreCounts := map[string]int{}
	for _, id := range optionIDs {
		scoreCounts[id] = 0
	}
	for _, choice := range ballots {
		for _, pair := range strings.Split(choice, ",") {
			parts := strings.SplitN(strings.TrimSpace(pair), ":", 2)
			if len(parts) != 2 {
				continue
			}
			optID := strings.TrimSpace(parts[0])
			score, err := strconv.Atoi(strings.TrimSpace(parts[1]))
			if err != nil {
				continue
			}
			if _, ok := sums[optID]; !ok {
				continue
			}
			sums[optID] += float64(score)
			scoreCounts[optID]++
		}
	}
	avg := zeroCounts(optionIDs)
	for _, id := range optionIDs {
		if scoreCounts[id] > 0 {
			avg[id] = sums[id] / float64(scoreCounts[id])
		}
	}
	winner := pickMaxByCount(avg)
	// "Vote share" has no natural ballot-count meaning for a scored method;
	// we use the winner's average as a fraction of the maximum possible
	// score (100) as the supermajority-eligibility proxy.
	share := avg[winner] / 100.0
	w := winner
	return methodOutcome{Counts: avg, WinnerOptionID: &w, WinnerShare: share}
}

func zeroCounts(optionIDs []string) map[string]float64 {
	c := make(map[string]float64, len(optionIDs))
	for _, id := range optionIDs {
		c[id] = 0
	}
	return c
}

// parseRankings turns each ballot's comma-separated ordered option list
// into a slice of known option IDs (unknown IDs are dropped defensively).
func parseRankings(ballots []string, optionIDs []string) [][]string {
	known := make(map[string]bool, len(optionIDs))
	for _, id := range optionIDs {
		known[id] = true
	}
	rankings := make([][]string, len(ballots))
	for i, choice := range ballots {
		var ranking []string
		for _, optID := range strings.Split(choice, ",") {
			optID = strings.TrimSpace(optID)
			if known[optID] {
				ranking = append(ranking, optID)
			}
		}
		rankings[i] = ranking
	}
	return rankings
}

// tallyRankedChoice runs Instant-Runoff Voting: each round every ballot's
// top remaining choice gets a vote; a strict majority wins outright;
// otherwise all options tied for fewest votes are eliminated together and
// the round repeats.
func tallyRankedChoice(optionIDs []string, rankings [][]string) methodOutcome {
	remaining := make(map[string]bool, len(optionIDs))
	for _, id := range optionIDs {
		remaining[id] = true
	}
	lastCounts := zeroCounts(optionIDs)

	for {
		counts := zeroCounts(optionIDs)
		total := 0
		for _, ranking := range rankings {
			for _, optID := range ranking {
				if remaining[optID] {
					counts[optID]++
					total++
					break
				}
			}
		}

		if total == 0 {
			// No remaining ballot has a remaining choice left to give --
			// fall back to the last round that did have votes (lastCounts).
			break
		}
		lastCounts = counts

		for _, id := range sortedKeys(counts) {
			if counts[id] > float64(total)/2 {
				w := id
				return methodOutcome{Counts: counts, WinnerOptionID: &w, WinnerShare: counts[id] / float64(total)}
			}
		}

		min := math.MaxFloat64
		for id := range remaining {
			if counts[id] < min {
				min = counts[id]
			}
		}
		for id := range remaining {
			if counts[id] == min {
				delete(remaining, id)
			}
		}
		if len(remaining) == 0 {
			break
		}
	}

	winner := pickMaxByCount(lastCounts)
	total := 0.0
	for _, v := range lastCounts {
		total += v
	}
	share := 0.0
	if total > 0 {
		share = lastCounts[winner] / total
	}
	w := winner
	return methodOutcome{Counts: lastCounts, WinnerOptionID: &w, WinnerShare: share}
}

// tallyComparative runs a Condorcet method with Copeland-score fallback. An
// option not ranked by a ballot is treated as least-preferred on that
// ballot, so any ranked option beats an unranked one; two options both
// unranked by a ballot express no preference between them on that ballot.
func tallyComparative(optionIDs []string, rankings [][]string) methodOutcome {
	pairwise := make(map[string]map[string]int, len(optionIDs))
	for _, a := range optionIDs {
		pairwise[a] = make(map[string]int, len(optionIDs))
	}

	for _, ranking := range rankings {
		pos := make(map[string]int, len(ranking))
		for i, id := range ranking {
			if _, ok := pos[id]; !ok {
				pos[id] = i
			}
		}
		for _, a := range optionIDs {
			for _, b := range optionIDs {
				if a == b {
					continue
				}
				pa, aRanked := pos[a]
				pb, bRanked := pos[b]
				aBeforeB := false
				switch {
				case aRanked && bRanked:
					aBeforeB = pa < pb
				case aRanked && !bRanked:
					aBeforeB = true
				}
				if aBeforeB {
					pairwise[a][b]++
				}
			}
		}
	}

	copeland := make(map[string]float64, len(optionIDs))
	beatsEveryone := make(map[string]bool, len(optionIDs))
	for _, a := range optionIDs {
		wins := 0
		for _, b := range optionIDs {
			if a == b {
				continue
			}
			if pairwise[a][b] > pairwise[b][a] {
				wins++
			}
		}
		copeland[a] = float64(wins)
		beatsEveryone[a] = wins == len(optionIDs)-1
	}

	var condorcet []string
	for _, id := range optionIDs {
		if beatsEveryone[id] {
			condorcet = append(condorcet, id)
		}
	}
	winner := ""
	if len(condorcet) > 0 {
		sort.Strings(condorcet)
		winner = condorcet[0]
	} else {
		winner = pickMaxByCount(copeland)
	}

	winTotal, oppTotal := 0, 0
	for _, b := range optionIDs {
		if b == winner {
			continue
		}
		winTotal += pairwise[winner][b]
		oppTotal += pairwise[winner][b] + pairwise[b][winner]
	}
	share := 0.0
	if oppTotal > 0 {
		share = float64(winTotal) / float64(oppTotal)
	}

	w := winner
	return methodOutcome{Counts: copeland, WinnerOptionID: &w, WinnerShare: share}
}
