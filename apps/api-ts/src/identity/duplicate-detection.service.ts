import { Inject, Injectable } from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { PrismaService } from "../prisma/prisma.service.js";

// ADR-034 D6, exported so it's independently unit-testable (no I/O).
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(handle: string): string {
  return handle.normalize("NFKC").trim().toLowerCase();
}

export interface DuplicateSignal {
  citizenIdA: string;
  citizenIdB: string;
  distance: number;
}

const HANDLE_SIMILARITY_THRESHOLD = 2;
const BURST_WINDOW_MS = 60 * 60 * 1000;
const BURST_THRESHOLD = 20;

export interface RegistrationBurst {
  windowStart: Date;
  count: number;
  anomalous: boolean;
}

// FR-005 AC3/ADR-034 D6 (E1-13): duplicate-identity-signal-review and
// anomalous-creation-pattern-detection -- both surface candidates for
// human/administrative review, neither auto-acts (an auto-suspend path
// would itself be a fraud vector, ADR-034's own reasoning for D6).
@Injectable()
export class DuplicateDetectionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // Pairwise comparison of every non-revoked citizen's publicHandle, NFKC-
  // normalized, flagged when Levenshtein distance <= 2 -- catches near-
  // duplicates the exact legalIdentityHash check at registration can't
  // (different legal identifiers, suspiciously similar display names).
  async scanForDuplicateSignals(): Promise<DuplicateSignal[]> {
    const citizens = await this.prisma.forWorker((tx) =>
      tx.citizen.findMany({ where: { status: { not: "revoked" } }, select: { id: true, publicHandle: true } }),
    );
    const normalized = citizens.map((c) => ({ id: c.id, handle: normalize(c.publicHandle) }));
    const signals: DuplicateSignal[] = [];
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        const distance = levenshtein(normalized[i].handle, normalized[j].handle);
        if (distance <= HANDLE_SIMILARITY_THRESHOLD) {
          signals.push({ citizenIdA: normalized[i].id, citizenIdB: normalized[j].id, distance });
        }
      }
    }
    if (signals.length > 0) {
      await this.audit.emit({
        actionType: "identity.duplicate_signals_flagged",
        actorRef: "duplicate-scan",
        payload: { count: signals.length },
      });
    }
    return signals;
  }

  // ADR-034 D6: >20 registrations in the trailing hour is flagged
  // anomalous. Never auto-suspends.
  async detectRegistrationBurst(now: Date = new Date()): Promise<RegistrationBurst> {
    const windowStart = new Date(now.getTime() - BURST_WINDOW_MS);
    const count = await this.prisma.forWorker((tx) => tx.citizen.count({ where: { createdAt: { gte: windowStart, lte: now } } }));
    return { windowStart, count, anomalous: count > BURST_THRESHOLD };
  }
}

export { levenshtein, normalize };
