/**
 * A droppable serialized lane for Laya work that must never block its caller.
 *
 * The typed-decision worker answers strictly one request at a time, so a
 * caller that awaits its turn is really awaiting the queue. That is fine for
 * the blocking judge, which the user is already waiting on, and wrong for the
 * fast gate: a classification that arrives after the tool has run is worse
 * than none. The lane keeps one job in flight, bounds the queue, and sheds
 * rather than accumulates.
 */

export class LayaLaneDroppedError extends Error {
	constructor(message = "lane queue full") {
		super(message);
		this.name = "LayaLaneDroppedError";
	}
}

export interface LayaLaneOptions {
	/** Jobs running at once. The worker serializes internally; higher only queues. */
	concurrency?: number;
	/** Per-job wall clock, including queue wait. */
	timeoutMs?: number;
	/** Jobs waiting for a slot before new ones are shed. */
	queueLimit?: number;
}

interface LaneJob {
	run: (signal: AbortSignal) => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	queuedAt: number;
}

export class LayaLane {
	readonly #concurrency: number;
	readonly #timeoutMs: number;
	readonly #queueLimit: number;
	readonly #queue: LaneJob[] = [];
	#running = 0;

	constructor(options: LayaLaneOptions = {}) {
		this.#concurrency = Math.max(1, options.concurrency ?? 1);
		this.#timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
		this.#queueLimit = Math.max(0, options.queueLimit ?? 4);
	}

	/** Jobs waiting or running. Used by the fast gate to decide whether to bother. */
	get depth(): number {
		return this.#running + this.#queue.length;
	}

	/**
	 * Queue `job`. The returned promise settles when the job does, or earlier
	 * on timeout — the job itself is aborted and its late result discarded.
	 * Rejects with `LayaLaneDroppedError` rather than queueing unboundedly.
	 */
	submit<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#queue.length >= this.#queueLimit) {
			return Promise.reject(new LayaLaneDroppedError(`lane queue full (${this.#queueLimit})`));
		}
		return new Promise<T>((resolve, reject) => {
			this.#queue.push({
				run: job as (signal: AbortSignal) => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
				queuedAt: performance.now(),
			});
			this.#pump();
		});
	}

	#pump(): void {
		while (this.#running < this.#concurrency && this.#queue.length > 0) {
			const job = this.#queue.shift();
			if (!job) return;
			this.#running += 1;
			void this.#run(job);
		}
	}

	async #run(job: LaneJob): Promise<void> {
		const controller = new AbortController();
		let settled = false;
		let released = false;
		// The slot is freed when the job is settled, not when its promise
		// happens to resolve: a job that ignores its abort signal must not hold
		// the lane after it has already been given up on.
		const release = () => {
			if (released) return;
			released = true;
			this.#running -= 1;
			this.#pump();
		};
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			release();
			fn();
		};

		// The budget covers queue wait as well: a job that has already been
		// waiting out its window is stale the moment it starts.
		const remainingMs = Math.max(1, this.#timeoutMs - (performance.now() - job.queuedAt));
		const timer = setTimeout(() => {
			const error = new Error("laya lane job timed out");
			error.name = "TimeoutError";
			controller.abort(error);
			settle(() => job.reject(error));
		}, remainingMs);
		timer.unref?.();

		try {
			const value = await job.run(controller.signal);
			settle(() => job.resolve(value));
		} catch (error) {
			settle(() => job.reject(error));
		} finally {
			clearTimeout(timer);
			release();
		}
	}
}
