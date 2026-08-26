-- TBL-001 (citizen) and TBL-002 (identity_verification), per
-- .spec/technical/database/tbl-001.md and tbl-002.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE citizenship_status AS ENUM ('citizen', 'revoked', 'suspended');
CREATE TYPE citizen_account_status AS ENUM ('pending', 'active', 'inactive', 'revoked');
CREATE TYPE verification_method AS ENUM ('national_id', 'passport', 'gov_credential');
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected');

CREATE TABLE citizen (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_handle text NOT NULL UNIQUE,
  citizenship_status citizenship_status NOT NULL DEFAULT 'citizen',
  legal_identity_hash text NOT NULL,
  status citizen_account_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FR-001: a citizen cannot hold more than one active civic identity, and a
-- second pending registration for the same legal identity is rejected
-- synchronously rather than racing DP-002's activation.
CREATE UNIQUE INDEX citizen_legal_identity_hash_live_idx
  ON citizen (legal_identity_hash)
  WHERE status IN ('pending', 'active');

CREATE TABLE identity_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id uuid NOT NULL REFERENCES citizen (id),
  method verification_method NOT NULL,
  evidence_ref text NOT NULL,
  verified_at timestamptz,
  status verification_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX identity_verification_citizen_id_idx ON identity_verification (citizen_id);
