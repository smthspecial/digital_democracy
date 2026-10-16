"""Deterministic synthetic fixtures shared by the local seed command and tests."""
from datetime import date, datetime, timedelta, timezone
import hashlib
import hmac
import uuid


def fixture_id(kind, name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'https://digital-democracy.test/seed/v1/{kind}/{name}'))


# The last two fields describe the identity state and residency scenario.
USERS = [
    ('alice', 'active', 'eligible'), ('bob', 'active', 'eligible'),
    ('carol', 'active', 'eligible'), ('david', 'active', 'eligible'),
    ('emma', 'active', 'eligible'), ('frank-unverified', 'active', 'unverified'),
    ('grace-new-resident', 'active', 'recent'), ('henry-outside', 'active', 'outside'),
    ('ivy-pending', 'pending', 'none'), ('james-rejected', 'pending', 'rejected'),
    ('kate-inactive', 'inactive', 'eligible'), ('leo-revoked', 'revoked', 'eligible'),
    ('maria-reviewer', 'active', 'eligible'), ('noah-review-body', 'active', 'eligible'),
    ('olivia-transport', 'active', 'eligible'), ('paul-environment', 'active', 'eligible'),
    ('quinn-auditor', 'active', 'eligible'), ('rose-oversight', 'active', 'eligible'),
    ('sam-operator', 'active', 'eligible'), ('tara-platform', 'active', 'eligible'),
    ('uma-suspended', 'active', 'suspended'), ('victor', 'active', 'eligible'),
]
ROLES = {'maria-reviewer': 'reviewer', 'noah-review-body': 'review_body',
         'quinn-auditor': 'auditor', 'rose-oversight': 'oversight',
         'sam-operator': 'operator', 'tara-platform': 'platform_operator'}


def dataset(secret, today=None):
    if not secret:
        raise ValueError('IDENTITY_HASH_SECRET is required')
    today = today or datetime.now(timezone.utc).date()
    now = datetime.combine(today, datetime.min.time(), timezone.utc)
    tables = {'api_ts': {}, 'api_go': {}}

    def add(db, table, key, **fields):
        row = {'id': fixture_id(table, key), **fields}
        tables[db].setdefault(table, []).append(row)
        return row['id']

    country = add('api_ts', 'jurisdiction', 'country', name='Seed Republic', scope_level='national', boundary_ref='seed://country', min_residency_days=180, population=10000)
    north = add('api_ts', 'jurisdiction', 'north', name='Seed North Municipality', scope_level='municipality', parent_id=country, boundary_ref='seed://north', min_residency_days=180, population=100, support_rate_bps=100, min_threshold=2)
    south = add('api_ts', 'jurisdiction', 'south', name='Seed South Municipality', scope_level='municipality', parent_id=country, boundary_ref='seed://south', min_residency_days=180, population=100, support_rate_bps=100, min_threshold=2)
    add('api_ts', 'jurisdiction', 'street', name='Seed School Street', scope_level='street', parent_id=north, boundary_ref='seed://street', min_residency_days=0, population=20, min_threshold=1)
    for handle, status, scenario in USERS:
        citizen = add('api_ts', 'citizen', handle, public_handle=f'seed-{handle}', status=status,
                      citizenship_status='suspended' if scenario == 'suspended' else 'citizen',
                      legal_identity_hash=hmac.new(secret.encode(), f'SYNTHETIC-SEED-v1-{handle}'.encode(), hashlib.sha256).hexdigest())
        if status != 'pending' or scenario == 'rejected':
            add('api_ts', 'identity_verification', handle, citizen_id=citizen, method='national_id', evidence_ref=f'seed://synthetic-identity/{handle}', status='rejected' if scenario == 'rejected' else 'verified', verified_at=now if scenario != 'rejected' else None)
        if scenario not in ('none', 'rejected'):
            jurisdiction = south if scenario == 'outside' else north
            verified = scenario != 'unverified'
            add('api_ts', 'jurisdiction_membership', handle, citizen_id=citizen, jurisdiction_id=jurisdiction)
            add('api_ts', 'residency', handle, citizen_id=citizen, jurisdiction_id=jurisdiction,
                start_date=today - timedelta(days=7 if scenario == 'recent' else 730), verified=verified,
                verification_decision='verified' if verified else None, reviewed_at=now if verified else None,
                reviewed_by_citizen_id=fixture_id('citizen', 'maria-reviewer') if verified else None)
    for handle, role in ROLES.items():
        add('api_ts', 'governance_role', handle, citizen_id=fixture_id('citizen', handle), role_type=role,
            layer='implementation' if role in ('operator', 'platform_operator') else 'audit',
            term_start=today - timedelta(days=30), term_end=today + timedelta(days=365), randomized=role not in ('operator', 'platform_operator'))
    domains = {}
    for name, expert in [('transport', 'olivia-transport'), ('environment', 'paul-environment')]:
        domains[name] = add('api_ts', 'expert_domain', name, name=f'Seed {name}', description='Synthetic competency domain for testing')
        add('api_ts', 'competency', name, citizen_id=fixture_id('citizen', expert), domain_id=domains[name], level=3,
            status='active', stage='decided', evidence_ref=f'seed://synthetic-qualification/{name}', granted_at=now - timedelta(days=30), expires_at=now + timedelta(days=365))
    category = add('api_ts', 'budget_category', 'transport', jurisdiction_id=north, name='Seed transport budget', allocated_amount=100000)
    add('api_ts', 'budget_category', 'environment', jurisdiction_id=north, name='Seed environment budget', allocated_amount=50000)
    road = add('api_ts', 'problem', 'road', author_id=fixture_id('citizen', 'alice'), title='Seed: safer school crossing', description='Synthetic scenario: improve pedestrian safety near a school.', affected_area='Seed School Street', jurisdiction_id=north)
    park = add('api_ts', 'problem', 'park', author_id=fixture_id('citizen', 'bob'), title='Seed: restore the community park', description='Synthetic scenario: replace damaged paths and plant shade trees.', affected_area='Seed North Park', jurisdiction_id=north)
    water = add('api_ts', 'problem', 'water', author_id=fixture_id('citizen', 'henry-outside'), title='Seed: South water monitoring', description='Synthetic outside-jurisdiction scenario.', affected_area='Seed South', jurisdiction_id=south)
    for key, problem in [('road', road), ('park', park), ('water', water)]:
        add('api_ts', 'problem_evidence', key, problem_id=problem, citizen_id=fixture_id('citizen', 'alice' if key != 'water' else 'henry-outside'), kind='statement', ref='Synthetic first-hand statement, not real evidence')
    for handle in ['alice', 'bob', 'carol']:
        add('api_ts', 'problem_support', 'road-'+handle, problem_id=road, citizen_id=fixture_id('citizen', handle))
    proposals = {}
    for name, problem, status, title, scoped in [
        ('draft', park, 'draft', 'Seed: park design draft', False),
        ('support', park, 'gathering_support', 'Seed: park planting programme', False),
        ('development', road, 'development', 'Seed: raised school crossing', True),
        ('alternative', road, 'development', 'Seed: pedestrian signal alternative', True),
        ('voting', road, 'voting', 'Seed: crossing ballot fixture', True),
        ('approved', park, 'approved', 'Seed: approved park restoration fixture', True),
        ('rejected', road, 'rejected', 'Seed: rejected road widening fixture', True),
        ('outside', water, 'draft', 'Seed: South water proposal', False),
    ]:
        proposal = add('api_ts', 'proposal', name, problem_id=problem, author_id=fixture_id('citizen', 'henry-outside' if name == 'outside' else 'alice'), title=title,
                      description='Synthetic test proposal; no real decision or election is represented.', status=status,
                      scope_jurisdiction_id=north if scoped else None, scope_rationale='Synthetic reviewed impact scope' if scoped else None,
                      support_threshold=2, support_count=3 if problem == road else 0,
                      objectives=None if name == 'draft' else 'Improve accessibility and public safety',
                      measurable_outcomes=None if name == 'draft' else 'Compare accessibility and incident reports after implementation',
                      implementation_timeline=None if name == 'draft' else 'Complete within six months of contractor appointment')
        proposals[name] = proposal
        if name != 'draft':
            add('api_ts', 'proposal_budget', name, proposal_id=proposal, cost=25000, funding_source='Synthetic local transport allocation', funding_category_id=category, maintenance_cost=500, long_term_cost=30000, expected_benefits='Safer accessible public spaces')
        if status in ('development', 'voting', 'approved'):
            add('api_ts', 'expert_assessment', name, proposal_id=proposal, expert_id=fixture_id('citizen', 'olivia-transport'), domain_id=domains['transport'], technical_score=4, economic_score=3, social_score=4, sustainability_score=4, body='Synthetic expert assessment: feasible under the stated test assumptions.')
    project = add('api_ts', 'project', 'park', proposal_id=proposals['approved'], timeline_start=today - timedelta(days=14), timeline_end=today + timedelta(days=150), budget_allocated=25000, budget_spent=5000, contractor='Synthetic Seed Works', status='in_progress')
    for name, days, status in [('survey', -7, 'done'), ('accessible-path', 45, 'pending'), ('planting', 90, 'pending')]:
        add('api_ts', 'project_milestone', name, project_id=project, name='Seed '+name, due_date=today + timedelta(days=days), completed_at=now if status == 'done' else None, status=status)
    add('api_ts', 'ledger_entry', 'park-spend', jurisdiction_id=north, category_id=category, project_id=project, direction='outflow', amount=5000, source='Synthetic seed milestone expenditure', occurred_at=now)
    for handle, assignment in [('maria-reviewer', 'proposal_review'), ('quinn-auditor', 'audit_review'), ('rose-oversight', 'budget_oversight')]:
        add('api_ts', 'civic_assignment', handle, citizen_id=fixture_id('citizen', handle), type=assignment, target_ref=proposals['development'], due_at=now + timedelta(days=30), status='assigned')
    for handle in ['alice', 'bob', 'carol']:
        add('api_ts', 'participation_record', handle, citizen_id=fixture_id('citizen', handle), period=today.strftime('%Y-%m'), score=2, quota_target=4)
        add('api_ts', 'budget_allocation_vote', handle, citizen_id=fixture_id('citizen', handle), category_id=category, percentage=50, period=today.strftime('%Y-%m'))
    session = add('api_go', 'vote_session', 'scheduled', proposal_id=proposals['voting'], jurisdiction_id=north, method='approval', threshold_rule='simple_majority', min_participation=0.5,
                  cooling_off_until=now + timedelta(days=2), opens_at=now + timedelta(days=3), closes_at=now + timedelta(days=10), status='scheduled')
    add('api_go', 'vote_option', 'crossing', vote_session_id=session, proposal_id=proposals['voting'], label='Seed crossing option', description='Synthetic option; no encrypted ballot or tally is seeded')
    add('api_go', 'vote_option', 'signal', vote_session_id=session, proposal_id=proposals['alternative'], label='Seed signal alternative', description='Synthetic competing proposal')
    for name in ['Ballot secrecy', 'Equal civic participation', 'Freedom of expression']:
        add('api_go', 'constitutional_right', name, name='Seed: '+name, description='Synthetic protected right for review tests', protected=True)
    return tables


def literal(value):
    if value is None: return 'NULL'
    if isinstance(value, bool): return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)): return str(value)
    if isinstance(value, (date, datetime)): value = value.isoformat()
    return "'" + str(value).replace("'", "''") + "'"


def seed_sql(tables):
    statements = ['BEGIN;', 'SET LOCAL standard_conforming_strings = on;']
    for table, rows in tables.items():
        for row in rows:
            statements.append(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join(literal(v) for v in row.values())}) ON CONFLICT (id) DO NOTHING;")
    return '\n'.join(statements + ['COMMIT;', ''])
