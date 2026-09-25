/**
 * Coverage accounting for the Tier-1 fast gate.
 *
 * Mirrors codex's `ScoreState`/`CachedScore`: the cached score is always the
 * newest successful sample, and a failure updates coverage facts only — it
 * never replaces a newer sample. `lag` and `hasUnscoredFailure` are what the
 * escalation path reads to decide whether a score is worth trusting at all.
 */
import type { AuthorizationLevel, CachedScore, FastGateClassification, ScoreCoverage } from "./types";

/** Authorization levels that mean "the user has not actually authorized this". */
const WEAK_AUTHORIZATION: ReadonlySet<AuthorizationLevel> = new Set(["low", "unknown"]);

export interface AutomodeScoreLedgerOptions {
	/** Classifications kept for the weak-authorization window. */
	windowSize?: number;
	/** Weak samples inside the window that force escalation regardless of risk. */
	weakAuthorizationLimit?: number;
}

export type ScoreFailureReason = "scoring-failure" | "timeout" | "oversized" | "unavailable";

/**
 * Per-session ledger of fast-gate samples.
 *
 * `publish` is single-assignment in the sense that only the newest sample
 * becomes the cached one; a late answer for an older call is recorded for
 * coverage but cannot demote the cache. That is the property codex states as
 * "failures never replace a newer sample", generalized to out-of-order
 * successes as well.
 */
export class AutomodeScoreLedger {
	readonly #windowSize: number;
	readonly #weakAuthorizationLimit: number;
	readonly #window: AuthorizationLevel[] = [];
	readonly #oversizedSeqs = new Set<number>();

	#latest: CachedScore | undefined;
	#coverage: ScoreCoverage = {
		latestToolCallSeq: 0,
		latestScoredSeq: 0,
		latestFailedSeq: 0,
		oversizedToolCalls: 0,
	};

	constructor(options: AutomodeScoreLedgerOptions = {}) {
		this.#windowSize = Math.max(1, options.windowSize ?? 8);
		this.#weakAuthorizationLimit = Math.max(1, options.weakAuthorizationLimit ?? 3);
	}

	/** Monotonic counter for fires; callers hand the seq to `publish`/`recordFailure`. */
	get latestToolCallSeq(): number {
		return this.#coverage.latestToolCallSeq;
	}

	/** Assign the next fire sequence. Separate from `publish` so a fire can be tracked before it resolves. */
	nextSeq(): number {
		this.#coverage.latestToolCallSeq += 1;
		return this.#coverage.latestToolCallSeq;
	}

	/** Record an input that could not be classified at all (over budget, empty, malformed). */
	recordOversized(seq: number): void {
		this.#oversizedSeqs.add(seq);
		this.#coverage.oversizedToolCalls = this.#oversizedSeqs.size;
		this.recordFailure(seq, "oversized");
	}

	/**
	 * Record a failed or timed-out attempt. Touches coverage only: an older
	 * failure must not clobber a newer successful sample.
	 */
	recordFailure(seq: number, _reason: ScoreFailureReason): void {
		if (seq <= this.#coverage.latestFailedSeq) return;
		this.#coverage.latestFailedSeq = seq;
	}

	/** Publish a successful classification. Newer-by-seq wins; older ones are coverage-only. */
	publish(classification: FastGateClassification): CachedScore {
		if (this.#latest === undefined || classification.seq > this.#coverage.latestScoredSeq) {
			this.#coverage.latestScoredSeq = classification.seq;
			this.#latest = {
				classification,
				lag: this.#lag(),
				hasUnscoredFailure: this.#hasUnscoredFailure(),
			};
			this.#windowPush(classification.authorization.level);
		}
		// Return the cached view so callers never see a stale sample presented as current.
		return this.#latest;
	}

	/** The newest successful sample, with coverage facts as of now. */
	latest(): CachedScore | undefined {
		if (!this.#latest) return undefined;
		return {
			classification: this.#latest.classification,
			lag: this.#lag(),
			hasUnscoredFailure: this.#hasUnscoredFailure(),
		};
	}

	coverage(): ScoreCoverage {
		return { ...this.#coverage };
	}

	/**
	 * True when the recent window is dominated by weak authorization. Risk can
	 * read low on a call the user never asked for, so authorization decay is
	 * its own escalation trigger.
	 */
	weakAuthorizationWindow(): boolean {
		if (this.#window.length === 0) return false;
		let weak = 0;
		for (const level of this.#window) if (WEAK_AUTHORIZATION.has(level)) weak += 1;
		return weak >= this.#weakAuthorizationLimit;
	}

	#lag(): number {
		return Math.max(0, this.#coverage.latestToolCallSeq - this.#coverage.latestScoredSeq);
	}

	#hasUnscoredFailure(): boolean {
		return this.#coverage.latestFailedSeq > this.#coverage.latestScoredSeq;
	}

	#windowPush(level: AuthorizationLevel): void {
		this.#window.push(level);
		while (this.#window.length > this.#windowSize) this.#window.shift();
	}
}
