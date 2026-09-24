import { describe, expect, test } from "bun:test";
import { TinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

const MODEL_KEY = "lfm2.5-230m";

type ReplyFactory = (request: TinyWorkerRequest) => TinyWorkerResponse;

class FakeHandle implements RefCountedWorkerHandle<TinyWorkerRequest, TinyWorkerResponse> {
	readonly sent: TinyWorkerRequest[] = [];
	#messages = new Set<(message: TinyWorkerResponse) => void>();
	#reply: ReplyFactory;
	refCount = 0;
	terminated = false;

	constructor(reply: ReplyFactory) {
		this.#reply = reply;
	}

	send(request: TinyWorkerRequest): void {
		this.sent.push(request);
		queueMicrotask(() => this.emit(this.#reply(request)));
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	terminate(): Promise<void> {
		this.terminated = true;
		return Promise.resolve();
	}

	ref(): void {
		this.refCount++;
	}

	unref(): void {
		this.refCount--;
	}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messages) handler(message);
	}
}

function loadReply(request: TinyWorkerRequest): TinyWorkerResponse {
	if (request.type !== "load") throw new Error(`unexpected request ${request.type}`);
	return { type: "loaded", id: request.id };
}

function textReply(request: TinyWorkerRequest): TinyWorkerResponse {
	if (request.type !== "chat") throw new Error(`unexpected request ${request.type}`);
	return { type: "text", id: request.id, text: "<title>Recovered</title>" };
}

function loadedReply(request: TinyWorkerRequest): TinyWorkerResponse {
	if (request.type !== "chat") throw new Error(`unexpected request ${request.type}`);
	return { type: "loaded", id: request.id };
}

function textForLoad(request: TinyWorkerRequest): TinyWorkerResponse {
	if (request.type !== "load") throw new Error(`unexpected request ${request.type}`);
	return { type: "text", id: request.id, text: "wrong response" };
}

describe("TinyTitleClient response correlation", () => {
	test("drops a worker when load receives text and reconnects on the next load", async () => {
		const first = new FakeHandle(textForLoad);
		const replacement = new FakeHandle(loadReply);
		const handles = [first, replacement];
		let connectCount = 0;
		const client = new TinyTitleClient(async () => {
			connectCount++;
			const handle = handles.shift();
			if (!handle) throw new Error("unexpected extra connection");
			return handle;
		});

		await expect(client.downloadModel(MODEL_KEY)).resolves.toMatchObject({ ok: false });
		expect(first.terminated).toBe(true);
		expect(first.refCount).toBe(0);

		await expect(client.downloadModel(MODEL_KEY)).resolves.toMatchObject({ ok: true });
		expect(connectCount).toBe(2);
		await client.terminate();
	});

	test("drops a worker when chat receives loaded and reconnects on the next title", async () => {
		const first = new FakeHandle(loadedReply);
		const replacement = new FakeHandle(textReply);
		const handles = [first, replacement];
		let connectCount = 0;
		const client = new TinyTitleClient(async () => {
			connectCount++;
			const handle = handles.shift();
			if (!handle) throw new Error("unexpected extra connection");
			return handle;
		});

		await expect(client.generate(MODEL_KEY, "draft a title")).resolves.toBeNull();
		expect(first.terminated).toBe(true);
		expect(first.refCount).toBe(0);

		await expect(client.generate(MODEL_KEY, "draft a title")).resolves.toBe("Recovered");
		expect(connectCount).toBe(2);
		await client.terminate();
	});
});
