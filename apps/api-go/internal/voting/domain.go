// Package voting implements voting-service (SRV-008).
//
// Responsibility per .spec/technical/services/srv-008.md: full voting
// lifecycle — sessions, cooling-off, blind eligibility tokens, encrypted
// ballots, tallies, certification. Cryptographic separation of identity
// from ballot content (ADR-002): eligibility_token carries citizen_id,
// ballot deliberately does not.
package voting

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

// Voting methods (TBL-019.method).
const (
	MethodRankedChoice    = "ranked_choice"
	MethodApproval        = "approval"
	MethodPreferenceScore = "preference_score"
	MethodComparative     = "comparative"
)

// Threshold rules (TBL-019.threshold_rule).
const (
	ThresholdSimpleMajority     = "simple_majority"
	ThresholdMajorityPlusQuorum = "majority_plus_quorum"
	ThresholdSupermajority      = "supermajority"
)

// Session statuses (TBL-019.status). Terminal states are closed (failed
// quorum) and certified.
const (
	SessionScheduled = "scheduled"
	SessionOpen      = "open"
	SessionClosed    = "closed"
	SessionCertified = "certified"
)

// VoteSession is TBL-019.
type VoteSession struct {
	ID               string       `json:"id"`
	ProposalID       string       `json:"proposal_id"`
	JurisdictionID   string       `json:"jurisdiction_id"`
	Method           string       `json:"method"`
	ThresholdRule    string       `json:"threshold_rule"`
	MinParticipation float64      `json:"min_participation"`
	CoolingOffUntil  time.Time    `json:"cooling_off_until"`
	OpensAt          time.Time    `json:"opens_at"`
	ClosesAt         time.Time    `json:"closes_at"`
	Status           string       `json:"status"`
	TallyResult      *TallyResult `json:"tally_result,omitempty"`
	CreatedAt        time.Time    `json:"created_at"`
}

// VoteOption is TBL-020: one option per competing proposal (FR-018).
type VoteOption struct {
	ID          string `json:"id"`
	SessionID   string `json:"vote_session_id"`
	ProposalID  string `json:"proposal_id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// EligibilityToken is TBL-021. It carries CitizenID; Ballot must not.
// TokenBlind is transient: populated only in the DP-025 issuance response
// so the citizen learns the unblinded one-time token. It is never stored.
type EligibilityToken struct {
	ID               string    `json:"id"`
	SessionID        string    `json:"vote_session_id"`
	CitizenID        string    `json:"citizen_id"`
	BlindedTokenHash string    `json:"blinded_token_hash"`
	IssuedAt         time.Time `json:"issued_at"`
	Used             bool      `json:"used"`
	TokenBlind       string    `json:"token_blind,omitempty"`
}

// Ballot is TBL-022. DELIBERATELY no CitizenID (NFR-001, ADR-002).
type Ballot struct {
	ID               string    `json:"id"`
	SessionID        string    `json:"vote_session_id"`
	TokenBlind       string    `json:"token_blind"`
	EncryptedChoice  string    `json:"encrypted_choice"`
	VerificationCode string    `json:"verification_code"`
	CastAt           time.Time `json:"cast_at"`
}

// TallyResult is the DP-026 output stored on the session. Winner/Decided
// record the method/threshold_rule evaluation (US-032): for ranked-choice,
// preference-score, and comparative methods the encrypted choices carry no
// order information at this layer, so the outcome is the first-preference
// plurality and full rounds run post-decryption upstream.
type TallyResult struct {
	SessionID    string         `json:"vote_session_id"`
	Counts       map[string]int `json:"counts"`
	TotalBallots int            `json:"total_ballots"`
	Winner       string         `json:"winner,omitempty"`
	Decided      bool           `json:"decided"`
	ComputedAt   time.Time      `json:"computed_at"`
}

var (
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("conflict")
	ErrInvalid      = errors.New("invalid request")
	ErrInvalidState = errors.New("invalid session state for this transition")
)

func validMethod(m string) bool {
	switch m {
	case MethodRankedChoice, MethodApproval, MethodPreferenceScore, MethodComparative:
		return true
	}
	return false
}

func validThreshold(t string) bool {
	switch t {
	case ThresholdSimpleMajority, ThresholdMajorityPlusQuorum, ThresholdSupermajority:
		return true
	}
	return false
}

// newID returns a 128-bit hex id (uuid-shaped uniqueness without deps).
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	// Dashed UUID format: matches the UUID columns in db/migrations.
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// newToken returns a 256-bit hex one-time token / verification code.
func newToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
