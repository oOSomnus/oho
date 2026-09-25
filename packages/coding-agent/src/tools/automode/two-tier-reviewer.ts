/**
 * Tier-2 orchestration: consult the fast gate, then fall through to the
 * blocking judge.
 *
 * The whole class exists to keep one invariant visible in one place — the fast
 * gate can hand out an `allow`, and nothing else. It has no path to a denial,
 * and a gate that is disabled, stale, unconfident, or broken always lands on
 * the blocking reviewer rather than on a silent pass. If that reviewer is
 * itself unavailable, the decision stays `unavailable` and the human prompt
 * remains the last stop.
 */
import type {
	ApprovalClassificationSummary,
	ApprovalReviewMeta,
	FastGateClassification,
	FastGateHandoffReason,
} from "./types";
import type { ToolApprovalReview, ToolApprovalReviewer, ToolApprovalReviewRequest } from "../approval-automode";
import type { FastGate } from "./fast-gate";

export interface TwoTierReviewerDependencies {
	/** The blocking judge path. Owns the actual allow/deny decision. */
	inner: ToolApprovalReviewer;
	fastGate: Pick<FastGate, "evaluate">;
	/** Off means the gate is not consulted at all — same behavior as before it existed. */
	isEnabled?: () => boolean;
	/**
	 * Called whenever the gate handed off instead of passing, so coverage can
	 * be watched without reading it out of the transcript.
	 */
	onHandoff?: (handoff: FastGateHandoffReason, request: ToolApprovalReviewRequest) => void;
}

/** The gate's classification, reduced to what the audit notice renders. */
export function summarizeClassification(
	classification: FastGateClassification | undefined,
): ApprovalClassificationSummary | undefined {
	if (!classification) return undefined;
	return {
		risk: classification.risk.level,
		authorization: classification.authorization.level,
	};
}

function withMeta(review: ToolApprovalReview, meta: ApprovalReviewMeta): ToolApprovalReview {
	return {
		...review,
		// The blocking reviewer stamps itself; only fill in what it left blank.
		actor: review.actor ?? meta.actor,
		handoff: review.handoff ?? meta.handoff,
		classification: review.classification ?? meta.classification,
	};
}

export class TwoTierToolApprovalReviewer implements ToolApprovalReviewer {
	readonly #dependencies: TwoTierReviewerDependencies;

	constructor(dependencies: TwoTierReviewerDependencies) {
		this.#dependencies = dependencies;
	}

	async review(request: ToolApprovalReviewRequest, signal?: AbortSignal): Promise<ToolApprovalReview> {
		const { inner, fastGate, isEnabled, onHandoff } = this.#dependencies;
		if (isEnabled && !isEnabled()) return inner.review(request, signal);

		const verdict = fastGate.evaluate(request.toolCallId);
		const classification = summarizeClassification(verdict.classification);

		if (verdict.kind === "pass") {
			// The only decision the gate is allowed to produce.
			return {
				decision: "allow",
				actor: "fast-gate",
				handoff: verdict.handoff,
				classification,
			};
		}

		onHandoff?.(verdict.handoff, request);
		const review = await inner.review(request, signal);
		return withMeta(review, {
			actor: "judge",
			handoff: verdict.handoff,
			classification,
		});
	}
}
