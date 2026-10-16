#!/usr/bin/env python3
"""Bounded probes against processes started here. Use disposable databases only.

Build api-go to /tmp/dd-security-api-go first. This runner starts/stops its own
APIs and fixture server; it never accepts a deployed target URL. TS assurance
probes use a explicitly labeled validator fixture, not a forged real session.
"""
import argparse
import collections
import datetime as dt
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
RESULTS = []
SECRET = "disposable-security-test-secret"
ACTOR = str(uuid.uuid4())


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def clean(value):
    if isinstance(value, dict):
        return {k: "[redacted]" if k in {"access_token", "refresh_token", "token_blind",
                "ceremony_token", "enrollment_grant", "blinded_token_hash"} else clean(v)
                for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str) and len(value) > 1024:
        return f"[string of {len(value)} characters]"
    return value


def request(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        res = urllib.request.urlopen(req, timeout=12)
    except urllib.error.HTTPError as err:
        res = err
    raw = res.read()
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw.decode(errors="replace")[:512]
    return res.status, value


def probe(base, name, method, path, body=None, headers=None, success=None, finding=None):
    status, value = request(base, method, path, body, headers)
    matched = success(status, value) if success else status in (200, 201)
    RESULTS.append({"case": name, "method": method, "path": path,
                    "request": clean(body), "request_headers": {
                        k: "[redacted bearer]" if k.lower() == "authorization" else v
                        for k, v in (headers or {}).items()},
                    "status": status, "response": clean(value),
                    "verdict": ("confirmed" if finding else "defended") if matched else "unexpected",
                    "finding": finding})
    return status, value


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/auth/validate":
            tier = self.headers.get("Authorization", "").removeprefix("Bearer security-fixture-")
            status = 200 if tier in ("T1", "T2", "T3") else 401
            body = {"citizen_id": ACTOR, "session_id": "fixture-session", "assurance_tier": tier}
        elif self.path.startswith("/identity/"):
            status, body = 200, {"status": "active"}
        elif self.path.startswith("/competency/"):
            status, body = 200, {"active": True}
        else:
            status, body = 404, {}
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, *args):
        pass


def wait_ready(base, process):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError("API exited; inspect temporary API logs")
        try:
            if request(base, "GET", "/healthz")[0] == 200:
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError("API did not become ready")


def go_probes(base):
    now = dt.datetime.now(dt.timezone.utc)
    stamp = lambda delta: (now + dt.timedelta(seconds=delta)).isoformat()
    proposal, jurisdiction = str(uuid.uuid4()), str(uuid.uuid4())
    _, session = probe(base, "anonymous session creation", "POST", "/voting/sessions", {
        "proposal_id": proposal, "jurisdiction_id": jurisdiction, "method": "approval",
        "threshold_rule": "simple_majority", "min_participation": 0,
        "cooling_off_until": stamp(-20), "opens_at": stamp(-10), "closes_at": stamp(-1)}, finding="SEC-01")
    sid = session["id"]
    probe(base, "anonymous session open", "POST", f"/voting/sessions/{sid}/open", {}, finding="SEC-01")
    _, issued = probe(base, "anonymous arbitrary citizen token issuance", "POST", f"/voting/sessions/{sid}/tokens",
                      {"citizen_ids": [str(uuid.uuid4())]}, finding="SEC-01")
    token = issued["tokens"][0]
    ballot = {"vote_session_id": sid, "token_id": token["id"], "token_blind": token["token_blind"],
              "encrypted_choice": "security-choice-outside-option-set"}
    _, cast = probe(base, "anonymous cast with invalid bearer and expired voting deadline", "POST", "/voting/ballots",
                    ballot, {"Authorization": "Bearer deliberately-invalid"}, finding="SEC-01")
    probe(base, "same eligibility token replay", "POST", "/voting/ballots", ballot,
          success=lambda s, b: s == 409)
    probe(base, "presence-only ballot verification", "GET", "/voting/ballots/verify?code=" + cast["verification_code"],
          success=lambda s, b: s == 200 and b.get("present") and "encrypted_choice" not in b)
    probe(base, "anonymous option insertion after voting opened", "POST", f"/voting/sessions/{sid}/options",
          {"proposal_id": proposal, "label": "injected option"}, finding="SEC-01")
    probe(base, "anonymous close", "POST", f"/voting/sessions/{sid}/close", {}, finding="SEC-01")
    probe(base, "anonymous tally accepts out-of-option value", "POST", f"/voting/sessions/{sid}/tally", {},
          success=lambda s, b: s == 200 and b.get("winner") == ballot["encrypted_choice"], finding="SEC-01")
    probe(base, "anonymous certification", "POST", f"/voting/sessions/{sid}/certify", {},
          success=lambda s, b: s == 200 and b.get("status") == "certified", finding="SEC-01")
    probe(base, "anonymous late option insertion after certification", "POST", f"/voting/sessions/{sid}/options",
          {"proposal_id": proposal, "label": "post-certification option"}, finding="SEC-06")
    probe(base, "bounded 1 MiB option description", "POST", f"/voting/sessions/{sid}/options",
          {"proposal_id": proposal, "label": "size probe", "description": "a" * (1024 * 1024)}, finding="SEC-07")
    probe(base, "forged audit author", "POST", "/audit/log",
          {"action_type": "vote_certified", "actor_ref": "voting-service", "payload": "fabricated certification"}, finding="SEC-02")
    probe(base, "forged audit event still passes chain verification", "GET", "/audit/verify",
          success=lambda s, b: s == 200 and b.get("valid") is True, finding="SEC-02")
    _, change = probe(base, "anonymous protocol registration with caller-selected delay", "POST", "/audit/protocol-changes",
                      {"change_ref": "security-change-" + sid, "required_approval_refs": ["audit", "council"],
                       "delay_until": stamp(-1), "visible_since": stamp(-2)}, finding="SEC-02")
    cid = change["id"]
    for approval in ("audit", "council"):
        probe(base, "same actor fabricates " + approval + " approval", "POST", f"/audit/protocol-changes/{cid}/approvals",
              {"ref": approval, "approver_ref": "same-untrusted-person"}, finding="SEC-02")
    probe(base, "unilateral protocol release", "POST", f"/audit/protocol-changes/{cid}/release", {},
          success=lambda s, b: s == 200 and b.get("status") == "released", finding="SEC-02")
    delegator = str(uuid.uuid4())
    _, delegation = probe(base, "anonymous delegation impersonation", "POST", "/delegation/delegations",
                          {"delegator_id": delegator, "delegate_id": str(uuid.uuid4()),
                           "domain_id": str(uuid.uuid4()), "expires_at": stamp(3600)}, finding="SEC-03")
    probe(base, "revocation without citizen header", "DELETE", "/delegation/delegations/" + delegation["id"],
          success=lambda s, b: s == 200 and b.get("revoked_at") is not None, finding="SEC-03")
    for path in ("/auth/login", "/auth/factors", "/auth/stepup", "/auth/identities/provision", "/auth/revoke-all",
                 "/auth/passkeys/registration/begin", "/auth/passkeys/login/finish", "/auth/refresh", "/auth/logout"):
        probe(base, "reject invalid auth " + path, "POST", path, {"citizen_id": delegator},
              {"Authorization": "Bearer invalid"}, success=lambda s, b: s == 401 or (path == "/auth/logout" and s == 404))
    for path in ("/auth/validate", "/auth/events"):
        probe(base, "reject invalid auth " + path, "GET", path, success=lambda s, b: s == 401)
    body = {"citizen_id": delegator}
    timestamp = str(int(time.time()))
    digest = hashlib.sha256(json.dumps(body).encode()).hexdigest()
    signature = hmac.new(SECRET.encode(), f"POST\n/auth/revoke-all\n{timestamp}\n{digest}".encode(), hashlib.sha256).hexdigest()
    headers = {"X-DD-Service": "api-ts", "X-DD-Timestamp": timestamp, "X-DD-Signature": signature}
    probe(base, "valid signed internal control", "POST", "/auth/revoke-all", body, headers,
          success=lambda s, b: s == 200)
    probe(base, "signed internal request replay in timestamp window", "POST", "/auth/revoke-all", body, headers,
          success=lambda s, b: s == 200, finding="SEC-10")


def seed_ts(admin_url):
    source = """
import pg from 'pg';
const client = new pg.Client({connectionString: process.env.SECURITY_ADMIN_URL});
await client.connect();
await client.query("INSERT INTO citizen (id, public_handle, legal_identity_hash, status) VALUES ($1,$2,$3,'active')", [process.env.SECURITY_ACTOR, 'security-reviewer-' + process.env.SECURITY_ACTOR, process.env.SECURITY_ACTOR]);
await client.query("INSERT INTO governance_role (citizen_id,role_type,layer,term_start,term_end,randomized) VALUES ($1,'auditor','audit',CURRENT_DATE-1,CURRENT_DATE+1,true)", [process.env.SECURITY_ACTOR]);
await client.end();
"""
    subprocess.run(["node", "--input-type=module", "-e", source], cwd=ROOT / "apps/api-ts",
                   env={**os.environ, "SECURITY_ADMIN_URL": admin_url, "SECURITY_ACTOR": ACTOR}, check=True)


def ts_probes(base):
    for headers in ({}, {"X-Citizen-ID": ACTOR}, {"Authorization": "Bearer invalid"}):
        probe(base, "TS approval rejects anonymous or spoofed citizen", "POST", "/governance-role/approvals",
              {"actionRef": "security-check", "approvalType": "audit_confirmation", "decision": "approved"},
              headers, success=lambda s, b: s == 401)
    for tier in ("T1", "T2"):
        probe(base, "TS accepts " + tier + " governance approval (validator fixture)", "POST", "/governance-role/approvals",
              {"actionRef": "security-assurance-" + tier, "approvalType": "audit_confirmation", "decision": "approved"},
              {"Authorization": "Bearer security-fixture-" + tier}, finding="SEC-04")
    ids = []
    for suffix in ("a", "b"):
        _, citizen = probe(base, "synthetic pending registration " + suffix, "POST", "/identity/citizens",
                           {"publicHandle": "security-near-" + ACTOR[:8] + suffix, "legalIdentifier": str(uuid.uuid4())},
                           success=lambda s, b: s == 201)
        ids.append(citizen["id"])
    probe(base, "anonymous worker duplicate scan exposes pending identities", "GET", "/identity/duplicates/scan",
          success=lambda s, b: s == 200 and any({x["citizenIdA"], x["citizenIdB"]} == set(ids) for x in b), finding="SEC-05")
    probe(base, "anonymous registration burst worker query", "GET", "/identity/registrations/burst-check", finding="SEC-05")
    probe(base, "reject unsigned verifier callback", "POST", "/identity/citizens/" + ids[0] + "/verifications",
          {"method": "national_id", "evidenceRef": "synthetic", "outcome": "verified"}, success=lambda s, b: s == 401)
    probe(base, "reject anonymous own-identity read", "GET", "/identity/citizens/" + ids[0], success=lambda s, b: s == 401)
    probe(base, "reject extra registration field", "POST", "/identity/citizens",
          {"publicHandle": "security-extra", "legalIdentifier": str(uuid.uuid4()), "status": "active"}, success=lambda s, b: s == 400)
    probe(base, "reputation direct write route absent", "POST", "/reputation/records", {}, success=lambda s, b: s == 404)


def local_url(value):
    if value and urllib.parse.urlparse(value).hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Only disposable loopback databases are permitted")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go-database-url", type=local_url)
    parser.add_argument("--ts-admin-url", type=local_url)
    parser.add_argument("--ts-app-url", type=local_url)
    parser.add_argument("--ts-worker-url", type=local_url)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if any((args.ts_admin_url, args.ts_app_url, args.ts_worker_url)) and not all((args.ts_admin_url, args.ts_app_url, args.ts_worker_url)):
        parser.error("All three TS database URLs are required together")
    fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    fixture_url = f"http://127.0.0.1:{fixture.server_port}"
    processes = []
    logs = []
    env = {k: v for k, v in os.environ.items() if not any(
        x in k for x in ("DATABASE_URL", "SERVICE_URL", "NATS_URL", "REQUIRE_", "WEBAUTHN_"))}
    env.update(INTERNAL_SERVICE_SHARED_SECRET=SECRET, WEBAUTHN_RP_ID="localhost",
               WEBAUTHN_RP_ORIGIN="http://localhost:3000", COMPETENCY_SERVICE_URL=fixture_url,
               IDENTITY_SERVICE_URL=fixture_url, NATS_URL="", AUDIT_SERVICE_URL="")
    try:
        go_port = port()
        log = tempfile.NamedTemporaryFile(prefix="dd-security-go-", delete=False)
        logs.append(log)
        process = subprocess.Popen(["/tmp/dd-security-api-go"], cwd=ROOT / "apps/api-go",
                                   env={**env, "PORT": str(go_port), "DATABASE_URL": args.go_database_url or ""},
                                   stdout=log, stderr=log)
        processes.append(process)
        base = f"http://127.0.0.1:{go_port}"
        wait_ready(base, process)
        go_probes(base)
        if args.ts_admin_url:
            seed_ts(args.ts_admin_url)
            ts_port = port()
            log = tempfile.NamedTemporaryFile(prefix="dd-security-ts-", delete=False)
            logs.append(log)
            process = subprocess.Popen(["node", "--import", "@swc-node/register/esm-register", "src/main.ts"],
                                       cwd=ROOT / "apps/api-ts", env={**env, "PORT": str(ts_port),
                                       "DATABASE_URL": args.ts_app_url, "WORKER_DATABASE_URL": args.ts_worker_url,
                                       "AUTH_SERVICE_URL": fixture_url, "IDENTITY_HASH_SECRET": SECRET,
                                       "IDENTITY_VERIFIER_SHARED_SECRET": SECRET}, stdout=log, stderr=log)
            processes.append(process)
            base = f"http://127.0.0.1:{ts_port}"
            wait_ready(base, process)
            ts_probes(base)
    finally:
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        fixture.shutdown()
        fixture.server_close()
        for log in logs:
            print("API log:", log.name)
            log.close()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"go_storage": "postgres" if args.go_database_url else "memory",
            "ts_storage": "postgres" if args.ts_admin_url else "not tested",
            "fixtures": "identity active, competency active; TS validator supplies valid T1/T2 contexts",
            "results": RESULTS}, indent=2) + "\n")
    print(dict(collections.Counter(x["verdict"] for x in RESULTS)))
    if any(x["verdict"] == "unexpected" for x in RESULTS):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
