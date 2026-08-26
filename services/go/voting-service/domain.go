package main

import "time"

type VoteMethod string

const (
	MethodRankedChoice    VoteMethod = "ranked_choice"
	MethodApproval        VoteMethod = "approval"
	MethodPreferenceScore VoteMethod = "preference_score"
	MethodComparative     VoteMethod = "comparative"
)

func (m VoteMethod) valid() bool {
	switch m {
	case MethodRankedChoice, MethodApproval, MethodPreferenceScore, MethodComparative:
		return true
	}
	return false
}

type ThresholdRule string

const (
	ThresholdSimpleMajority     ThresholdRule = "simple_majority"
	ThresholdMajorityPlusQuorum ThresholdRule = "majority_plus_quorum"
	ThresholdSupermajority      ThresholdRule = "supermajority"
)

func (t ThresholdRule) valid() bool {
	switch t {
	case ThresholdSimpleMajority, ThresholdMajorityPlusQuorum, ThresholdSupermajority:
		return true
	}
	return false
}

type SessionStatus string

const (
	StatusScheduled SessionStatus = "scheduled"
	StatusOpen      SessionStatus = "open"
	StatusClosed    SessionStatus = "closed"
	StatusCertified SessionStatus = "certified"
)

// VoteSession mirrors TBL-019.
type VoteSession struct {
	ID               string        `json:"id"`
	ProposalID       string        `json:"proposal_id"`
	JurisdictionID   string        `json:"jurisdiction_id"`
	Method           VoteMethod    `json:"method"`
	ThresholdRule    ThresholdRule `json:"threshold_rule"`
	MinParticipation float64       `json:"min_participation"`
	CoolingOffUntil  time.Time     `json:"cooling_off_until"`
	OpensAt          time.Time     `json:"opens_at"`
	ClosesAt         time.Time     `json:"closes_at"`
	Status           SessionStatus `json:"status"`
	CreatedAt        time.Time     `json:"created_at"`
}

// VoteOption mirrors TBL-020. Options may only be added while the owning
// session is status=scheduled.
type VoteOption struct {
	ID            string `json:"id"`
	VoteSessionID string `json:"vote_session_id"`
	ProposalID    string `json:"proposal_id"`
	Label         string `json:"label"`
	Description   string `json:"description"`
}

// EligibilityToken mirrors TBL-021. It carries citizen_id -- the ballot
// deliberately does not -- so the blinded hash is the only bridge, and it
// cannot be rejoined to ballot content (ADR-002, NFR-001).
type EligibilityToken struct {
	ID               string    `json:"id"`
	VoteSessionID    string    `json:"vote_session_id"`
	CitizenID        string    `json:"citizen_id"`
	BlindedTokenHash string    `json:"blinded_token_hash"`
	IssuedAt         time.Time `json:"issued_at"`
	Used             bool      `json:"used"`
}

// Ballot mirrors TBL-022. DELIBERATELY has no citizen_id field anywhere --
// token_blind is a fresh random value generated at cast time, not derived
// from the citizen's token secret, so it cannot be joined back to a citizen.
type Ballot struct {
	ID               string    `json:"id"`
	VoteSessionID    string    `json:"vote_session_id"`
	TokenBlind       string    `json:"token_blind"`
	EncryptedChoice  []byte    `json:"-"`
	Nonce            []byte    `json:"-"`
	VerificationCode string    `json:"verification_code"`
	CastAt           time.Time `json:"cast_at"`
}

// TallyResult is the outcome computed and stored by CloseSession.
type TallyResult struct {
	SessionID         string             `json:"session_id"`
	Method            VoteMethod         `json:"method"`
	Counts            map[string]float64 `json:"counts"`
	WinnerOptionID    *string            `json:"winner_option_id"`
	TotalBallots      int                `json:"total_ballots"`
	ParticipationRate float64            `json:"participation_rate"`
	QuorumMet         bool               `json:"quorum_met"`
	CertifiedAt       *time.Time         `json:"certified_at,omitempty"`
}
