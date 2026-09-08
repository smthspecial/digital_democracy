-- Voting queries (TBL-019…022). Atomic multi-step writes (DP-016 cast) are
-- orchestrated in Go transactions (pgStore) from these primitives.

-- name: CreateVoteSession :one
INSERT INTO vote_session (id, proposal_id, jurisdiction_id, method, threshold_rule, min_participation, cooling_off_until, opens_at, closes_at, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: GetVoteSession :one
SELECT * FROM vote_session WHERE id = $1;

-- name: ListVoteSessions :many
SELECT * FROM vote_session ORDER BY created_at, id;

-- name: UpdateVoteSessionStatus :one
UPDATE vote_session SET status = $2 WHERE id = $1
RETURNING *;

-- name: SetVoteSessionTally :one
UPDATE vote_session SET tally_result = $2 WHERE id = $1
RETURNING *;

-- name: CreateVoteOption :one
INSERT INTO vote_option (id, vote_session_id, proposal_id, label, description)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListVoteOptions :many
SELECT * FROM vote_option WHERE vote_session_id = $1 ORDER BY id;

-- name: InsertEligibilityToken :one
INSERT INTO eligibility_token (id, vote_session_id, citizen_id, blinded_token_hash, used)
VALUES ($1, $2, $3, $4, FALSE)
ON CONFLICT (vote_session_id, citizen_id) DO NOTHING
RETURNING *;

-- name: GetTokenBySessionCitizen :one
SELECT * FROM eligibility_token WHERE vote_session_id = $1 AND citizen_id = $2;

-- name: GetEligibilityToken :one
SELECT * FROM eligibility_token WHERE id = $1;

-- name: CountSessionTokens :one
SELECT count(*) FROM eligibility_token WHERE vote_session_id = $1;

-- name: LockEligibilityToken :one
SELECT * FROM eligibility_token WHERE id = $1 FOR UPDATE;

-- name: MarkTokenUsed :exec
UPDATE eligibility_token SET used = TRUE WHERE id = $1;

-- name: InsertBallot :one
INSERT INTO ballot (id, vote_session_id, token_blind, encrypted_choice, verification_code)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetBallotByVerification :one
SELECT * FROM ballot WHERE verification_code = $1;

-- name: ListSessionBallots :many
SELECT * FROM ballot WHERE vote_session_id = $1 ORDER BY cast_at, id;
