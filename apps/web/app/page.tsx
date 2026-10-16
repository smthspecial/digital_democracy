"use client";

import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { api, enroll, login, type Session } from "./lib/client";

type Problem = {
  id: string;
  title: string;
  description: string;
  jurisdictionId: string;
};
type Proposal = {
  id: string;
  problemId: string;
  title: string;
  description: string;
  status: string;
  authorId: string;
};
type Jurisdiction = { id: string; name: string; children: Jurisdiction[] };
type Project = {
  id: string;
  proposalId: string;
  status: string;
  contractor: string | null;
  budgetAllocated: number | null;
};
type Journey = {
  proposal: Proposal;
  problem: Problem;
  budget: Record<string, string | number | null> | null;
  alternatives: Proposal[];
  expertAnalysis: { assessment: string }[];
  eligible: boolean | null;
  missing: string[];
  voting: { status: string; reason: string };
  projects: Project[];
};

function Field({
  name,
  label,
  type = "text",
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}): React.JSX.Element {
  return (
    <label>
      {label}
      {type === "textarea" ? (
        <textarea name={name} required={required} maxLength={5000} />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          autoComplete={type === "password" ? "off" : undefined}
        />
      )}
    </label>
  );
}
function flatten(nodes: Jurisdiction[]): Jurisdiction[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function Form({
  label,
  children,
  action,
  authenticated = true,
  busy,
  signedIn,
  run,
}: {
  label: string;
  children: ReactNode;
  action: (data: Record<string, string>) => Promise<void>;
  authenticated?: boolean;
  busy: boolean;
  signedIn: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
}): React.JSX.Element {
  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form)) as Record<
          string,
          string
        >;
        void run(async () => {
          await action(data);
          form.reset();
        });
      }}
    >
      {children}
      <button disabled={busy || (authenticated && !signedIn)}>{label}</button>
    </form>
  );
}

export default function HomePage(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [citizen, setCitizen] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [pendingResidencies, setPendingResidencies] = useState<{ id: string; citizen: { publicHandle: string }; jurisdiction: { name: string } }[]>([]);
  const token = session?.access_token;

  async function refreshPublic() {
    const [p, proposals, tree, projects] = await Promise.all([
      api<Problem[]>("/problem/problems"),
      api<Proposal[]>("/proposal/proposals"),
      api<Jurisdiction[]>("/jurisdiction/jurisdictions"),
      api<Project[]>("/projects"),
    ]);
    setProblems(p);
    setProposals(proposals);
    setJurisdictions(flatten(tree));
    setProjects(projects);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  async function acceptSession(next: Session) {
    const identity = await api<{ citizen_id: string }>(
      "/auth/validate",
      next.access_token,
    );
    setCitizen(identity.citizen_id);
    setSession(next);
    setNotice("Signed in with your passkey.");
  }
  useEffect(() => {
    void refreshPublic().catch(() =>
      setError(
        "The services are unavailable. Start the local stack and reload.",
      ),
    );
    // Access tokens stay in memory. Only the HttpOnly cookie restores login.
    void api<Session>("/auth/refresh", undefined, {})
      .then(acceptSession)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        void api<Session>("/auth/refresh", undefined, {})
          .then(acceptSession)
          .catch(() => {
            setSession(null);
            setError("Your session expired. Sign in again.");
          });
      },
      Math.max(
        1000,
        new Date(session.access_expires_at).getTime() - Date.now() - 30_000,
      ),
    );
    return () => clearTimeout(timer);
  }, [session]);

  const jurisdictionSelect = (
    <label>
      Jurisdiction
      <select name="jurisdictionId" required>
        <option value="">Choose a community</option>
        {jurisdictions.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <main>
      <header>
        <a href="/" className="brand">
          Digital Democracy
        </a>
        <span>Citizen workspace</span>
      </header>
      <section className="intro">
        <p className="eyebrow">From an issue to a public outcome</p>
        <h1>Your community. Your decisions.</h1>
        <p>
          Verify your identity, develop proposals and follow their
          implementation.
        </p>
      </section>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="message" role="status">
          {notice}
        </p>
      )}
      <div className="columns">
        <section className="card">
          <h2>1. Your identity</h2>
          {session ? (
            <>
              <p>
                Signed in as <code>{citizen}</code>
              </p>
              <p>
                Assurance {session.assurance_tier}. Sensitive actions may
                require fresh authentication.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/auth/logout", token, {});
                    setSession(null);
                    setJourney(null);
                    setNotice("Signed out.");
                  })
                }
              >
                Sign out
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => acceptSession(await login(citizen)))
                }
              >
                Verify again
              </button>
            </>
          ) : (
            <>
              <h3>Register</h3>
              <Form
                busy={busy}
                signedIn={Boolean(session)}
                run={run}
                label="Register identity"
                authenticated={false}
                action={async (data) => {
                  const result = await api<{ id: string }>(
                    "/identity/citizens",
                    undefined,
                    data,
                  );
                  setCitizen(result.id);
                  setNotice(
                    `Registration received. Your citizen ID is ${result.id}. A trusted reviewer must verify your identity before issuing an enrollment grant.`,
                  );
                }}
              >
                <Field name="publicHandle" label="Public handle" />
                <Field name="legalIdentifier" label="Legal identifier" />
                <p className="hint">
                  Use synthetic details in the local pilot. Your identifier is
                  hashed by the identity service.
                </p>
              </Form>
              <h3>Enroll after verification</h3>
              <Form
                busy={busy}
                signedIn={Boolean(session)}
                run={run}
                label="Create passkey"
                authenticated={false}
                action={async (data) => {
                  await enroll(data.grant!);
                  setNotice("Passkey enrolled. Sign in with your citizen ID.");
                }}
              >
                <Field name="grant" label="Enrollment grant" type="password" />
                <p className="hint">
                  Obtain this short-lived grant from your trusted identity
                  reviewer. Registration alone does not approve your identity.
                </p>
              </Form>
              <h3>Sign in</h3>
              <Form
                busy={busy}
                signedIn={Boolean(session)}
                run={run}
                label="Sign in with passkey"
                authenticated={false}
                action={async (data) =>
                  acceptSession(await login(data.citizen!))
                }
              >
                <label>
                  Citizen ID
                  <input
                    name="citizen"
                    required
                    defaultValue={citizen}
                    autoComplete="username"
                  />
                </label>
              </Form>
            </>
          )}
        </section>
        <section className="card">
          <h2>2. Your community</h2>
          <p>
            Eligibility requires membership and verified residency in the
            affected jurisdiction.
          </p>
          <Form
            busy={busy}
            signedIn={Boolean(session)}
            run={run}
            label="Join and declare residency"
            action={async (data) => {
              await api("/jurisdiction/memberships", token, {
                jurisdictionId: data.jurisdictionId,
              });
              await api("/jurisdiction/residencies", token, {
                jurisdictionId: data.jurisdictionId,
                startDate: data.startDate,
              });
              setNotice(
                "Membership recorded and residency submitted for review. Eligibility starts after verification and the required residency period.",
              );
            }}
          >
            {jurisdictionSelect}
            <Field name="startDate" label="Resident since" type="date" />
          </Form>
          <h3>Raise an issue</h3>
          <Form
            busy={busy}
            signedIn={Boolean(session)}
            run={run}
            label="Publish issue"
            action={async (data) => {
              await api("/problem/problems", token, {
                ...data,
                evidenceKind: "statement",
              });
              await refreshPublic();
              setNotice("Issue published.");
            }}
          >
            <Field name="title" label="Title" />
            <Field name="description" label="Description" type="textarea" />
            <Field name="affectedArea" label="Affected area" />
            {jurisdictionSelect}
            <Field
              name="evidenceRef"
              label="Evidence or first-hand statement"
              type="textarea"
            />
          </Form>
        </section>
      </div>
      <section className="card">
        <h2>3. Issues and proposals</h2>
        <details>
          <summary>Assigned reviewer workspace</summary>
          <p>These actions require the corresponding active reviewer role and fresh passkey authentication.</p>
          <button disabled={busy || !session} onClick={() => void run(async () => setPendingResidencies(await api("/jurisdiction/residencies/pending", token)))}>Load residency reviews</button>
          {pendingResidencies.map((residency) => <div key={residency.id} className="proposal"><p>{residency.citizen.publicHandle} · {residency.jurisdiction.name}</p>{(["verified", "rejected"] as const).map((decision) => <button key={decision} disabled={busy} onClick={() => void run(async () => {
            await api(`/jurisdiction/residencies/${residency.id}/review`, token, { decision });
            setPendingResidencies(await api("/jurisdiction/residencies/pending", token)); setNotice(`Residency ${decision}.`);
          })}>{decision === "verified" ? "Verify residency" : "Reject residency"}</button>)}</div>)}
          <Form busy={busy} signedIn={Boolean(session)} run={run} label="Assign proposal scope" action={async (data) => {
            await api(`/proposal/proposals/${data.proposalId}/scope`, token, { jurisdictionId: data.jurisdictionId, rationale: data.rationale }); await refreshPublic(); setNotice("Impact scope assigned.");
          }}><label>Proposal<select name="proposalId" required><option value="">Choose a proposal</option>{proposals.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>{jurisdictionSelect}<Field name="rationale" label="Scope rationale" type="textarea" /></Form>
        </details>
        {problems.length === 0 && <p>No issues have been published.</p>}
        {problems.map((problem) => (
          <article key={problem.id}>
            <h3>{problem.title}</h3>
            <p>{problem.description}</p>
            <button
              disabled={busy || !session}
              onClick={() =>
                void run(async () => {
                  await api(
                    `/problem/problems/${problem.id}/support`,
                    token,
                    {},
                  );
                  await refreshPublic();
                  setNotice("Support recorded.");
                })
              }
            >
              Support issue
            </button>
            <details>
              <summary>Propose a solution</summary>
              <Form
                busy={busy}
                signedIn={Boolean(session)}
                run={run}
                label="Create proposal"
                action={async (data) => {
                  await api("/proposal/proposals", token, {
                    ...data,
                    problemId: problem.id,
                  });
                  await refreshPublic();
                  setNotice("Proposal draft created.");
                }}
              >
                <Field name="title" label="Title" />
                <Field
                  name="description"
                  label="Proposed solution"
                  type="textarea"
                />
              </Form>
            </details>
            {proposals
              .filter((p) => p.problemId === problem.id)
              .map((proposal) => (
                <div key={proposal.id} className="proposal">
                  <h4>
                    {proposal.title}{" "}
                    <span className="badge">{proposal.status}</span>
                  </h4>
                  <p>{proposal.description}</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setJourney(
                          await api<Journey>(
                            `/journey/proposals/${proposal.id}`,
                            token,
                          ),
                        ),
                      )
                    }
                  >
                    Read voting package
                  </button>
                  {proposal.authorId === citizen && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `/proposal/proposals/${proposal.id}/advance`,
                              token,
                              {},
                            );
                            await refreshPublic();
                            setNotice("Proposal advanced.");
                          })
                        }
                      >
                        Advance proposal
                      </button>
                      <details>
                        <summary>Complete proposal information</summary>
                        <Form
                          busy={busy}
                          signedIn={Boolean(session)}
                          run={run}
                          label="Save objectives"
                          action={async (data) => {
                            await api(
                              `/proposal/proposals/${proposal.id}/details`,
                              token,
                              data,
                            );
                            setNotice("Objectives saved.");
                          }}
                        >
                          <Field
                            name="objectives"
                            label="Objectives"
                            type="textarea"
                          />
                          <Field
                            name="measurableOutcomes"
                            label="Measurable outcomes"
                            type="textarea"
                          />
                          <Field
                            name="implementationTimeline"
                            label="Implementation timeline"
                          />
                        </Form>
                        <Form
                          busy={busy}
                          signedIn={Boolean(session)}
                          run={run}
                          label="Save funding information"
                          action={async (data) => {
                            await api(
                              `/proposal/proposals/${proposal.id}/budget`,
                              token,
                              {
                                ...data,
                                cost: Number(data.cost),
                                maintenanceCost: Number(data.maintenanceCost),
                                longTermCost: Number(data.longTermCost),
                              },
                            );
                            setNotice("Funding information saved.");
                          }}
                        >
                          <Field name="cost" label="Cost" type="number" />
                          <Field name="fundingSource" label="Funding source" />
                          <Field
                            name="maintenanceCost"
                            label="Maintenance cost"
                            type="number"
                          />
                          <Field
                            name="longTermCost"
                            label="Long-term cost"
                            type="number"
                          />
                          <Field
                            name="expectedBenefits"
                            label="Expected benefits"
                            type="textarea"
                          />
                        </Form>
                      </details>
                    </>
                  )}
                </div>
              ))}
          </article>
        ))}
      </section>
      {journey && (
        <section className="card">
          <h2>4. Voting package: {journey.proposal.title}</h2>
          <h3>The issue</h3>
          <p>{journey.problem.description}</p>
          <h3>The solution</h3>
          <p>{journey.proposal.description}</p>
          <h3>Funding and long-term impact</h3>
          {journey.budget ? (
            <dl>
              {Object.entries(journey.budget)
                .filter(
                  ([key]) =>
                    !["id", "proposalId", "fundingCategoryId"].includes(key),
                )
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}
                    </dt>
                    <dd>{value ?? "Not supplied"}</dd>
                  </div>
                ))}
            </dl>
          ) : (
            <p>Budget information is incomplete.</p>
          )}
          <h3>Expert analysis</h3>
          {journey.expertAnalysis.length ? (
            journey.expertAnalysis.map((a, i) => <p key={i}>{a.assessment}</p>)
          ) : (
            <p>No expert analysis is available.</p>
          )}
          <h3>Alternatives</h3>
          {journey.alternatives.map((p) => (
            <p key={p.id}>
              <strong>{p.title}</strong>: {p.description}
            </p>
          ))}
          <p>
            Eligibility:{" "}
            {journey.eligible === null
              ? "Sign in to check"
              : journey.eligible
                ? "Eligible under the current jurisdiction rules"
                : "Not currently eligible"}
            .
          </p>
          {journey.missing.length > 0 && (
            <p>Before voting: {journey.missing.join("; ")}.</p>
          )}
          <p className="message" role="status">
            {journey.voting.reason}
          </p>
        </section>
      )}
      <section className="card">
        <h2>5. Public implementation</h2>
        {projects.length === 0 ? (
          <p>
            No approved projects yet. Successful certified decisions appear here
            once reconciled.
          </p>
        ) : (
          projects.map((project) => (
            <article key={project.id}>
              <h3>
                {proposals.find((p) => p.id === project.proposalId)?.title ??
                  "Approved project"}
              </h3>
              <p>
                Status: {project.status}. Contractor:{" "}
                {project.contractor ?? "Not assigned"}. Allocated budget:{" "}
                {project.budgetAllocated ?? "Not supplied"}.
              </p>
            </article>
          ))
        )}
      </section>
      <footer>
        Local pilot · Real elections remain unavailable until the complete
        voting protocol is implemented and independently reviewed.
      </footer>
    </main>
  );
}
