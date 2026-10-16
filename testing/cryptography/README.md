# Blind eligibility credential experiment

TASK-007 component feasibility work, using synthetic identities and ephemeral
3072-bit RSA keys. All code is in `_test.go`; this standalone module is outside
`go.work` and is not imported by either API or included in application images.
It does not implement TASK-008 or approve a complete election protocol.

The experiment uses [CIRCL v1.6.5](https://github.com/cloudflare/circl/releases/tag/v1.6.5),
commit `cfa7c70defd831ffb0792ab2af560bfef43d60ca`, BSD-3-Clause,
with module checksums in `go.sum`. Cryptographic operations use its
`RSABSSA-SHA384-PSS-Randomized` implementation of
[RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html).
This is a CFRG informational specification, not an IETF Internet Standard.
Pinning a library and running its vectors does not establish an independent
audit of that version or this composition.

## Run

From this directory, using Go 1.27.1 and an available C compiler for `-race`:

```sh
GOWORK=off go mod download
GOWORK=off go mod verify
GOWORK=off go vet ./...
GOWORK=off go test -mod=readonly -race -count=1 ./... github.com/cloudflare/circl/blindsign/blindrsa
```

The root CI workflow runs these checks in its separate `cryptography` job.
Local evidence is retained in [results.json](results.json); remote CI execution
is not claimed. This does not rerun or qualify the older ElectionGuard prototype.

## Flow and checked boundaries

1. The client generates a random 32-byte nonce and prepares a message containing
   an application domain and the frozen election manifest hash. It blinds the
   message using the election's pinned public key.
2. A synthetic issuer authorizes an eligible citizen, sees only the blinded
   bytes and issues one signature. An exact request retry returns the original
   response; replacing the blinded request is rejected. Invalid-size, zero and
   out-of-range representatives do not consume issuance.
3. The client unblinds and verifies the response. A collector with only the
   public key independently verifies the RSA-PSS signature using Go's standard
   library and checks the expected domain, manifest and message length.
4. A local mutex protects token spending. The spent key hashes the domain,
   manifest and nonce, excluding both the randomized Prepare prefix and the
   signature. Signing the same nonce with different randomness cannot bypass
   the spent check. No citizen identifier is passed to the collector.

Tests exercise valid issuance, ineligible/replacement issuance, exact retries,
malformed inputs, modified tokens/signatures, wrong manifests/keys, a malicious
cross-election signing request, concurrent issuance/redemption, randomized
duplicate tokens and corrupted signing responses. The pinned upstream package's
full test suite also executes, including RFC vectors and signature encoding cases.

Each election has its own key, common to every voter and pinned before issuance.
A blind signer cannot inspect the hidden election hash: signing B's hidden
message using A's key must not yield a credential accepted in either election.
Per-voter keys would permit tagging and must not be substituted for this model.
Production key distribution, transparency and independent generation checks
are still design work.

## Limits and next integration work

- These are in-memory fixtures in one test process. Real authentication,
  jurisdiction eligibility, durable issuance/retry records and transactional
  spend-plus-ballot storage remain unimplemented. There are no process-restart,
  database, HTTP, browser or replica qualification claims.
- Structural separation is not a proof of operational anonymity. Issuance and
  redemption timing, IPs, logs, backups, issuer tagging and a compromised client
  need a complete threat model and independent analysis.
- A bearer token is transferable: a thief/coercer can redeem it first. A test
  explicitly demonstrates this limitation. The token does not bind a ciphertext;
  theft/front-running, ballot integrity and safe recovery remain protocol work.
- The manifest hashes are synthetic fixtures. The real election manifest,
  options/method/key binding, publication, client pinning, trustees and encrypted
  tally are not integrated here. All required voting methods remain unqualified.
- Blind credentials do not establish receipt-freeness or coercion resistance.
  Neither the library version nor its composition is independently approved.
  TASK-007/TASK-008 and ADR-042 stay open; production voting stays blocked.
