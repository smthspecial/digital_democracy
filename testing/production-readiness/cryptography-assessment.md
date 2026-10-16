# Cryptography assessment — 2026-10-08

Existing requirements remain unchanged: NFR-001 requires zero recoverable
identity-to-choice links and receipt-freeness; NFR-003 requires publicly
reproducible results. Production configuration now requires a verifier address,
but configuring an address is not evidence of a secure voting protocol.

| Candidate | Useful capability | Requirement gap |
| --- | --- | --- |
| ElectionGuard specification 2.1 | Encrypted ballots, proof verification, guardian/threshold operations and public verification; v2 range proofs can support scored ballots | Does not supply this application's anonymous credential issuance/submission system or establish remote receipt-freeness. Required methods and actual maintained implementation versions still need a prototype. |
| Belenios | Reviewed remote voting system with credentials, proofs and threshold trustees; ranked/scored modes are described as experimental | Its FAQ expressly describes coercion using voter credentials and encryption randomness. A compromised client is outside its protection. Its last-vote-wins behavior needs reconciliation with single-use credentials. |

These are candidate capabilities, not an independent assessment of this
application's composition. Maintenance status, licensing, review coverage and
pinned implementation artifacts must be recorded before choosing a dependency.

Primary sources: [ElectionGuard specification](https://electionguard.vote/spec/),
[Belenios FAQ](https://www.belenios.org/faq.html). The conclusion that neither
currently establishes all project requirements is an inference from those
sources and the application requirements.

| Adversary/failure | Required control and evidence |
| --- | --- |
| Compromised browser/mobile app | Define trusted voting/verifying device assumptions; demonstrate cast-as-intended checking. Server encryption cannot repair a client that records the choice. |
| Identity issuer and ballot operator correlate records | Blind/unlinkable credentials, independent domains, no shared citizen/session identifiers, bounded retention and explicit timing/IP metadata analysis. Current authenticated cast route is not a proven anonymous channel. |
| Trustees collude or a trustee is unavailable | Specify independently administered t-of-n holders, decryption proofs, ceremony transcript, share recovery and collusion threshold. No runtime can hold a reconstructable election key. |
| Coercer obtains randomness/device/credential | Establish receipt-freeness and coercion resistance under the stated remote-voting assumptions; an encryption receipt alone is insufficient. |
| Stolen or replayed credential, concurrent casts | Election-bound one-time eligibility, atomic unique spend, deadline checks, restart/replica races and an explicit recovery policy that preserves anonymity. |
| Malformed proof or substituted election/options | Reviewed verifier rejects malformed/oversized inputs; domain-separate manifest, options, method and public key. Negative vectors and independent verification must agree. |
| Dishonest tally or deleted/reordered ballots | Public commitment/bulletin board, reproducible inclusion and tally verification, threshold decryption/shuffle proofs for each required method. |
| Backup, telemetry or regional failover leaks data | Review all durable artifacts and logs; prevent identity-choice linkage and key-share co-location during recovery. Test failover against duplicate spending. |

Next executable protocol work requires a candidate that addresses the coercion
gap, an independent reviewer and trustee assignments. Run only synthetic
prototype elections until review closes all blocking findings. TASK-008 through
TASK-012 remain pending; no production encryption or threshold tally is claimed.

## Executed component prototype

The official MIT-licensed Python reference implementation 1.4.0 was checked out
at `a9753841f5082d1c35bdc1b053aade74778662b7` (latest checkout commit dated
2026-07-09) and installed from its unchanged `uv.lock` using system Python 3.12.
This implementation version must not be conflated with the newer 2.1 protocol
specification. The SDK's ordinary tests use insecure `TestOnly` primes; those
two passing harness tests were followed by a separate standard-parameter run.

[The reproducible runner](electionguard_prototype.py) explicitly selects the
SDK's standard 4096/256-bit groups and calls the official election example and
missing-guardian scenario without enabling the test harness's tiny primes.
[Five checks passed](cryptography-prototype-results.json): valid encryption
proofs, modified-response rejection, wrong-election-domain rejection, encrypted
accumulation/decryption/published-record reload matching synthetic results, and
2-of-3 compensated trustee decryption. All keys and voter choices in this
experiment were synthetic and co-located in a disposable directory.

This is feasibility evidence for cryptographic components, not an integrated
remote voting protocol, independently verified trustee custody or independent
review. No real citizen, production key or application deployment used this
SDK. Receipt-freeness, anonymous credentials, metadata protection and all
required methods remain unqualified. Production voting operations now return
503 regardless of whether a verifier URL is configured.

To reproduce, clone the official source, check out the exact revision, use
`uv sync --locked --python /usr/bin/python3.12 --group dev`, then run its
`.venv/bin/python` against this repository's `electionguard_prototype.py` with
`--source` and an absolute `--output` path. The SDK checkout and private outputs
must remain outside application images and git. Upstream review coverage and
security maintenance still require assessment before any production choice.

## Local credential experiment — 2026-10-14

[The isolated Go experiment](../cryptography/README.md) adds real blind-signature
issuance and unblinding with CIRCL v1.6.5 (`cfa7c70defd831ffb0792ab2af560bfef43d60ca`,
BSD-3-Clause), using RFC 9474's randomized SHA384/PSS variant and ephemeral
3072-bit keys. Go's standard RSA-PSS implementation verifies the resulting
credentials independently of CIRCL's verifier. The experiment is test-only,
outside both application dependency graphs, and does not select a full protocol.
See [retained results](../cryptography/results.json) for exact commands, source
hashes and executed test cases. In-memory issuance/spending checks do not
satisfy TASK-008's database, anonymity or recovery criteria.

The issuer authorizes synthetic citizens while the collector receives only a
prepared credential and signature. Dedicated election keys, pinned and common
to every voter in an election, prevent a malicious client from using one
election's issuer to obtain another election's credential. Spending is keyed
by the signed domain/manifest/nonce, excluding signature and Prepare randomness.
This avoids counting re-randomized credentials as new spends. The experiment
also demonstrates that a copied bearer credential can be spent by its holder;
it does not claim coercion resistance or protection against credential theft.

Library source/version and RFC vectors are primary implementation evidence,
not independent review. CIRCL's own [security disclaimer](https://github.com/cloudflare/circl#security-disclaimer)
requires evaluating the specific component and deployment before production.
[RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html) is an informational CFRG
document. No cryptographic primitives were reimplemented in this experiment.

### Receipt-freeness research continuation

Two further research directions deserve review before choosing a complete
protocol. These findings do not establish a deployable candidate:

- [BeleniosRF](https://eprint.iacr.org/2015/629) specifically targets strong
  receipt-freeness and end-to-end verifiability and reports an implementation.
  It is distinct from the deployed Belenios system discussed above. A maintained
  pinned implementation, exact trust/communication assumptions, licensing,
  independent security analysis and support for every required voting method
  have not been established for this project. Research it before any claim
  that receipt-freeness is impossible or that existing requirements must change.
- [VoteAgain](https://www.usenix.org/conference/usenixsecurity20/presentation/lueks)
  uses revoting for coercion resistance. A [subsequent security analysis](https://eprint.iacr.org/2020/1406)
  reports serious trust/security pitfalls in the analyzed design. Do not select
  that design without resolving those findings. Its revoting model also needs
  reconciliation with the application's one-time credential/spending rules.

The project inference remains that no assessed complete implementation has yet
met all requirements. This is not a claim that no such protocol can exist.
Continue local synthetic experiments while keeping production gates and the
independent design/implementation review criteria unchanged.
