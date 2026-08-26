import { randomUUID } from "node:crypto";
import type {
  AlternativeFraming,
  ArgumentInput,
  ArgumentWithId,
  Conflict,
  PreferenceInput,
  SharedObjective,
  Stance,
  SynthesisAnalysis,
  TradeoffSignal,
} from "../domain/types.js";

const STANCES: readonly Stance[] = ["agreement", "disagreement"];

// Two opposite-stance arguments are reported as a conflict when their
// lowercased word sets share at least this many distinct tokens.
const CONFLICT_TOKEN_OVERLAP_THRESHOLD = 3;

// Number of shared terms surfaced in an alternative framing string.
const FRAMING_TOP_TERMS = 5;

// Fixed keyword list scanned for tradeoff signals (word-boundary, case-insensitive).
const TRADEOFF_KEYWORDS = ["cost", "benefit", "risk", "delay", "safety", "funding"] as const;

function normalizeWhitespace(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(matches);
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => b.has(token)).sort();
}

function computeSharedObjectives(preferences: PreferenceInput[]): SharedObjective[] {
  const counts = new Map<string, number>();
  for (const preference of preferences) {
    const normalized = normalizeWhitespace(preference.description);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description));
}

function detectConflicts(args: ArgumentWithId[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let i = 0; i < args.length; i += 1) {
    for (let j = i + 1; j < args.length; j += 1) {
      const a = args[i];
      const b = args[j];
      if (!a || !b || a.stance === b.stance) continue;
      const overlap = intersect(tokenize(a.content), tokenize(b.content));
      if (overlap.length >= CONFLICT_TOKEN_OVERLAP_THRESHOLD) {
        conflicts.push({ argument_id_a: a.id, argument_id_b: b.id, overlapping_terms: overlap });
      }
    }
  }
  return conflicts;
}

function buildAlternativeFramings(args: ArgumentWithId[]): AlternativeFraming[] {
  const framings: AlternativeFraming[] = [];
  for (const stance of STANCES) {
    const own = args.filter((a) => a.stance === stance);
    if (own.length === 0) continue;
    const other = args.filter((a) => a.stance !== stance);
    const ownTokens = new Set(own.flatMap((a) => [...tokenize(a.content)]));
    const otherTokens = new Set(other.flatMap((a) => [...tokenize(a.content)]));
    const shared = intersect(ownTokens, otherTokens).slice(0, FRAMING_TOP_TERMS);
    const verb = stance === "agreement" ? "support" : "oppose";
    const sharedText = shared.length > 0 ? shared.join(", ") : "no shared terms identified";
    framings.push({
      stance,
      framing: `Citizens who ${verb} this proposal (${own.length} argument(s)) find common ground with the opposing side on: ${sharedText}.`,
    });
  }
  return framings;
}

function detectTradeoffs(args: ArgumentWithId[]): TradeoffSignal[] {
  const combined = args.map((a) => a.content).join(" ");
  const signals: TradeoffSignal[] = [];
  for (const keyword of TRADEOFF_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, "gi");
    const frequency = (combined.match(regex) ?? []).length;
    if (frequency > 0) {
      signals.push({ keyword, frequency });
    }
  }
  return signals.sort((a, b) => b.frequency - a.frequency || a.keyword.localeCompare(b.keyword));
}

export function runSynthesis(
  _proposalId: string,
  argumentsInput: ArgumentInput[],
  preferencesInput: PreferenceInput[],
): SynthesisAnalysis {
  const args: ArgumentWithId[] = argumentsInput.map((input) => ({ id: randomUUID(), ...input }));
  return {
    arguments: args,
    shared_objectives: computeSharedObjectives(preferencesInput),
    conflicts: detectConflicts(args),
    alternative_framings: buildAlternativeFramings(args),
    tradeoffs: detectTradeoffs(args),
  };
}
