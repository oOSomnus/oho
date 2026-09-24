import { describe, expect, test } from "bun:test";
import type { JudgmentRequest } from "@oh-my-pi/pi-ai";
import { LayaJudgeClient, type LayaJudgeLoadState } from "@oh-my-pi/pi-coding-agent/judgment/laya-client";
import type { LayaWorkerRequest, LayaWorkerResponse } from "@oh-my-pi/pi-coding-agent/judgment/laya-protocol";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

const request: JudgmentRequest = {
	state: "inspect files",
	questions: {
		risk: {
			type: "choice",
			instructions: "Choose risk.",
			criteria: { safe: "read-only", risky: "changes state" },
		},
	},
};

type ResponseFactory = (id: string) => LayaWorkerResponse;

class FakeHandle implements RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse> {
	readonly sent: LayaWorkerRequest[] = [];
	#messages = new Set<(message: LayaWorkerResponse) => void>();
	#errors = new Set<(error: Error) => void>();
	#autoJudge = true;
	#loadedDevice = "cpu";
	#loadReply: ResponseFactory | undefined;
	#judgeReply: ResponseFactory | undefined;
	refCount = 0;
	terminated = false;
	terminateCount = 0;
	readonly judgeSent = Promise.withResolvers<void>();

	autoJudge(value: boolean): void {
		this.#autoJudge = value;
	}

	loadedDevice(value: string): void {
		this.#loadedDevice = value;
	}

	loadReply(factory: ResponseFactory | undefined): void {
		this.#loadReply = factory;
	}

	judgeReply(factory: ResponseFactory | undefined): void {
		this.#judgeReply = factory;
	}

	send(message: LayaWorkerRequest): void {
		this.sent.push(message);
		if (message.type === "load") {
			const response =
				this.#loadReply?.(message.id) ??
				({ type: "loaded", id: message.id, device: this.#loadedDevice } satisfies LayaWorkerResponse);
			queueMicrotask(() => this.emit(response));
		}
		if (message.type === "judge") {
			this.judgeSent.resolve();
			if (!this.#autoJudge) return;
			const response =
				this.#judgeReply?.(message.id) ??
				({
					type: "judgment",
					id: message.id,
					result: {
						answers: {
							risk: { type: "choice", choice: "safe", probabilities: { safe: 1, risky: 0 }, confidence: 1 },
						},
					},
				} satisfies LayaWorkerResponse);
			queueMicrotask(() => this.emit(response));
		}
	}

	onMessage(handler: (message: LayaWorkerResponse) => void): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	terminate(): Promise<void> {
		this.terminated = true;
		this.terminateCount++;
		return Promise.resolve();
	}

	ref(): void {
		this.refCount++;
	}

	unref(): void {
		this.refCount--;
	}

	emit(message: LayaWorkerResponse): void {
		for (const handler of this.#messages) handler(message);
	}
}

function clientWith(handle: FakeHandle): LayaJudgeClient {
	return new LayaJudgeClient({ connect: async () => handle });
}

function clientWithConnect(connect: () => Promise<FakeHandle>): LayaJudgeClient {
	return new LayaJudgeClient({ connect });
}

describe("LayaJudgeClient", () => {
	test("coalesces the load lifecycle and reports the current state to subscribers", async () => {
		const handle = new FakeHandle();
		const client = clientWith(handle);
		const states: LayaJudgeLoadState[] = [];
		const unsubscribe = client.subscribeLoadState(state => states.push(state));

		await Promise.all([client.judge(request), client.judge(request)]);

		expect(handle.sent.map(message => message.type)).toEqual(["load", "judge", "judge"]);
		expect(states).toEqual(["idle", "loading", "ready"]);
		const lateStates: LayaJudgeLoadState[] = [];
		const unsubscribeLate = client.subscribeLoadState(state => lateStates.push(state));
		expect(lateStates).toEqual(["ready"]);
		unsubscribeLate();
		await client.terminate();
		expect(states).toEqual(["idle", "loading", "ready", "idle"]);
		unsubscribe();
	});

	test("rejects a worker that reports a non-CPU device", async () => {
		const handle = new FakeHandle();
		handle.loadedDevice("cuda");

		await expect(clientWith(handle).judge(request)).rejects.toThrow("non-CPU device cuda");
	});

	test("reports load failure and reaches ready after a retry", async () => {
		const handle = new FakeHandle();
		handle.loadReply(id => ({ type: "error", id, error: "model load failed" }));
		const client = clientWith(handle);
		const states: LayaJudgeLoadState[] = [];
		const unsubscribe = client.subscribeLoadState(state => states.push(state));

		await expect(client.judge(request)).rejects.toThrow("model load failed");
		expect(states).toEqual(["idle", "loading", "failed"]);

		handle.loadReply(undefined);
		await expect(client.judge(request)).resolves.toMatchObject({ answers: { risk: { choice: "safe" } } });
		expect(states).toEqual(["idle", "loading", "failed", "loading", "ready"]);
		await client.terminate();
		unsubscribe();
	});

	test("aborts a pending judgment and ignores its late response", async () => {
		const handle = new FakeHandle();
		handle.autoJudge(false);
		const client = clientWith(handle);
		const controller = new AbortController();
		const pending = client.judge(request, { signal: controller.signal });
		await handle.judgeSent.promise;
		controller.abort(new Error("caller stopped"));

		await expect(pending).rejects.toThrow("caller stopped");
		const judgeRequest = handle.sent.find(message => message.type === "judge");
		expect(judgeRequest?.type).toBe("judge");
		if (judgeRequest?.type === "judge") {
			handle.emit({
				type: "judgment",
				id: judgeRequest.id,
				result: { answers: {} },
			});
		}
		expect(handle.refCount).toBe(0);
		await client.terminate();
	});

	test("keeps a healthy worker after a request-level error", async () => {
		const handle = new FakeHandle();
		handle.judgeReply(id => ({ type: "error", id, error: "request failed" }));
		const client = clientWith(handle);

		await expect(client.judge(request)).rejects.toThrow("request failed");
		expect(handle.terminated).toBe(false);
		expect(handle.refCount).toBe(0);

		handle.judgeReply(undefined);
		await expect(client.judge(request)).resolves.toMatchObject({ answers: { risk: { choice: "safe" } } });
		await client.terminate();
	});

	test("resets all pending requests on a correlated pong and reconnects", async () => {
		const first = new FakeHandle();
		first.autoJudge(false);
		const replacement = new FakeHandle();
		const handles = [first, replacement];
		let connectCount = 0;
		const client = clientWithConnect(async () => {
			connectCount++;
			const handle = handles.shift();
			if (!handle) throw new Error("unexpected extra connection");
			return handle;
		});

		const firstPending = client.judge(request);
		await first.judgeSent.promise;
		const secondPending = client.judge(request);
		await Promise.resolve();
		const judgeRequests = first.sent.filter(
			(message): message is Extract<LayaWorkerRequest, { type: "judge" }> => message.type === "judge",
		);
		expect(judgeRequests).toHaveLength(2);
		const firstFailure = firstPending.then(
			() => null,
			error => error,
		);
		const secondFailure = secondPending.then(
			() => null,
			error => error,
		);
		first.emit({ type: "pong", id: judgeRequests[0].id, tag: "unexpected" });

		const firstError = await firstFailure;
		const secondError = await secondFailure;
		expect(firstError).toBeInstanceOf(Error);
		expect(secondError).toBeInstanceOf(Error);
		if (firstError instanceof Error) expect(firstError.message).toContain("unexpected pong");
		if (secondError instanceof Error) expect(secondError.message).toContain("unexpected pong");
		expect(first.terminated).toBe(true);
		expect(first.refCount).toBe(0);

		await expect(client.judge(request)).resolves.toMatchObject({ answers: { risk: { choice: "safe" } } });
		expect(connectCount).toBe(2);
		expect(replacement.sent.map(message => message.type)).toEqual(["load", "judge"]);
		await client.terminate();
	});

	test("resets the worker when load receives a judgment response", async () => {
		const handle = new FakeHandle();
		handle.loadReply(id => ({ type: "judgment", id, result: {} }));

		await expect(clientWith(handle).judge(request)).rejects.toThrow("unexpected judgment response for load");
		expect(handle.terminated).toBe(true);
		expect(handle.refCount).toBe(0);
	});

	test("resets the worker when judgment receives a loaded response", async () => {
		const handle = new FakeHandle();
		handle.judgeReply(id => ({ type: "loaded", id, device: "cpu" }));

		await expect(clientWith(handle).judge(request)).rejects.toThrow("unexpected loaded response for judge");
		expect(handle.terminated).toBe(true);
		expect(handle.refCount).toBe(0);
	});
});
