# Repeatable local test data

Run from the repository root. Podman is selected when installed; append
`--engine docker` to use Docker instead.

```sh
python3 infra/compose/seed.py seed
python3 infra/compose/seed.py users
```

`seed` builds/starts the existing development stack, applies both real migration
sets, stops application writers, and inserts missing fixtures into `api_ts` and
`api_go`. IDs are deterministic; rerunning preserves edited rows and enrolled
passkeys. The private `.env.local` and normal restricted runtime roles are reused.
If either seed transaction fails, applications stay stopped; repair the problem
and rerun. The two databases cannot share a PostgreSQL transaction.

To purge and recreate this local environment:

```sh
python3 infra/compose/seed.py reset
```

**`reset` deletes all `dd-local` Compose volumes**, including both databases,
passkeys/sessions, JetStream messages, and optional monitoring history. It keeps
`.env.local`, rebuilds/migrates the stack, and reloads the seed. It targets the
fixed `dd-local` project and repository Compose file. It does not address remote
database URLs. Use this command only for the synthetic development stack.

## Users and scenarios

All handles start with `seed-`. `users` prints stable citizen IDs for signing in.

| Handles | Scenario |
| --- | --- |
| alice, bob, carol, david, emma, victor | Active, verified, long-term North residents and members |
| frank-unverified | Pending residency review |
| grace-new-resident | Verified, but only seven days of residency; below the 180-day requirement |
| henry-outside | Eligible in South, outside North's scope |
| ivy-pending, james-rejected | Pending identity / rejected verification; cannot enroll |
| kate-inactive, leo-revoked, uma-suspended | Inactive identity, revoked identity, suspended citizenship |
| maria-reviewer, noah-review-body | Residency reviewer and scope review body |
| olivia-transport, paul-environment | Active competency in transport / environment |
| quinn-auditor, rose-oversight | Audit and oversight roles |
| sam-operator, tara-platform | Institutional and platform operators |

Additional fixtures include four jurisdictions, three problems, eight proposals
across draft/support/development/voting/approved/rejected states, complete and
incomplete voting packages, expert assessments, two budget categories, allocation
votes, a ledger entry, a project with three milestones, civic assignments,
participation records, one scheduled vote session with two alternatives, and
three protected constitutional rights. Dates are relative to the date the data
is created. Resetting refreshes the dates; a non-destructive seed preserves them.

The approved project is explicitly a synthetic scenario. No ballots, certified
results, cryptographic proofs, trustee keys or fabricated audit signatures are
seeded. Voting remains unavailable until the full protocol is implemented.

## Sign in with a real passkey

There are no seed passwords or shared private passkeys. For an active verified
fixture account, the local reviewer adapter issues an ordinary five-minute,
single-use first-passkey enrollment grant:

```sh
python3 infra/compose/seed.py enroll alice --output /tmp/dd-alice-enrollment.txt
```

Open the local web app (default `http://localhost:3001`), paste the grant into
**Enrollment grant**, and select **Create passkey**. Sign in with the ID printed
by `users`, then remove the private grant file. An existing enrolled account
cannot be overwritten with another first-passkey grant. After `reset`, enroll
again; old device credentials no longer correspond to the rebuilt database.

Fixtures are implementation/testing data, not proof that real legal identities,
governance appointments, residency reviews or elections were verified.
