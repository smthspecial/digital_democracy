-- Audit queries (TBL-034…036). The chain trigger enforces prev_hash on
-- insert; writers serialize on an advisory lock in Go (pgStore) so
-- concurrent appends cannot interleave tips.

-- name: GetAuditTip :one
SELECT payload_hash FROM audit_log ORDER BY seq DESC LIMIT 1;

-- name: InsertAuditEntry :one
INSERT INTO audit_log (id, action_type, actor_ref, payload_hash, prev_hash, signature, idempotency_key)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetEntryByIdempotencyKey :one
SELECT * FROM audit_log WHERE idempotency_key = $1;

-- name: GetAuditEntry :one
SELECT * FROM audit_log WHERE id = $1;

-- name: ListAuditEntries :many
SELECT * FROM audit_log ORDER BY seq LIMIT NULLIF($1, 0);

-- name: CountAuditEntries :one
SELECT count(*) FROM audit_log;

-- name: CreateConstitutionalRight :one
INSERT INTO constitutional_right (id, name, description, protected)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ListConstitutionalRights :many
SELECT * FROM constitutional_right ORDER BY id;

-- name: InsertConstitutionalReview :one
INSERT INTO constitutional_review (id, proposal_id, right_id, result, reviewer_ref)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListReviewsByProposal :many
SELECT * FROM constitutional_review WHERE proposal_id = $1 ORDER BY created_at, id;

-- name: ListAllReviews :many
SELECT * FROM constitutional_review ORDER BY created_at, id;

-- Protocol change gate (DP-043).

-- name: InsertProtocolChange :one
INSERT INTO protocol_change (id, change_ref, required_approval_refs, approvals, delay_until, visible_since, status)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetProtocolChange :one
SELECT * FROM protocol_change WHERE id = $1;

-- name: ListProtocolChanges :many
SELECT * FROM protocol_change ORDER BY created_at, id;

-- name: UpdateProtocolChange :one
UPDATE protocol_change SET approvals = $2, status = $3, released_at = $4
WHERE id = $1
RETURNING *;
