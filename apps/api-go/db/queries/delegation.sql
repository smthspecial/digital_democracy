-- Delegation queries (TBL-023). Cycle detection walks active edges in Go
-- (pgStore) from ListActiveDomainEdges, mirroring the in-memory store.

-- name: CreateDelegation :one
INSERT INTO delegation (id, delegator_id, delegate_id, domain_id, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetDelegation :one
SELECT * FROM delegation WHERE id = $1;

-- name: ListAllDelegations :many
SELECT * FROM delegation ORDER BY created_at, id;

-- name: RevokeDelegation :one
-- GREATEST keeps the revoked_at >= created_at invariant under app/DB clock
-- differences: revocation is effective immediately either way, and a
-- backdated revocation can never be recorded.
UPDATE delegation SET revoked_at = GREATEST($2, created_at) WHERE id = $1
RETURNING *;

-- name: ExpireDueDelegations :many
UPDATE delegation SET revoked_at = $1
WHERE expires_at <= $1 AND revoked_at IS NULL
RETURNING *;

-- name: ListActiveDomainEdges :many
SELECT delegator_id, delegate_id FROM delegation
WHERE domain_id = $1 AND revoked_at IS NULL AND expires_at > $2;
