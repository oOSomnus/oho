import * as path from "node:path";
import { $env, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { JudgeOptions, JudgmentRequest, Questions } from "@oh-my-pi/pi-ai";
import { stageRunnerScript } from "../eval/runner-cache";
import {
	connectJsonlWorker,
	JSONL_WORKER_CLOSED,
	LazyJsonlWorkerHandle,
	spawnDetachedJsonlWorker,
	type JsonlWorkerLaunch,
} from "../subprocess/jsonl-worker";
import { workerEnvFromParent, type RefCountedWorkerHandle } from "../subprocess/worker-client";
import LAYA_SERVER_SCRIPT from "./laya-server.py" with { type: "text" };
import {
	LAYA_WORKER_IDLE_MS,
	LAYA_WORKER_IDLE_MS_ENV,
	type LayaWorkerRequest,
	type LayaWorkerResponse,
	layaWorkerEndpoint,
	layaWorkerLogPath,
} from "./laya-protocol";
import {
	ensureLayaRuntime,
	getLayaModelCacheDir,
	getLayaWorkerRuntimeDir,
	LAYA_REPOSITORY,
	LAYA_SUBFOLDER,
	LAYA_VERSION,
} from "./laya-runtime";

export interface LayaJudgeClientOptions {
	connect?: () => Promise<RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse>>;
	runtimeDir?: string;
}

export type LayaJudgeLoadState = "idle" | "loading" | "ready" | "failed";

type LayaPending = {
	kind: "load" | "judge";
	resolve: (response: LayaWorkerResponse) => void;
	reject: (error: Error) => void;
};

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Laya judgment aborted");
}

function workerError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	const { promise: result, resolve, reject } = Promise.withResolvers<T>();
	const abort = (): void => reject(abortError(signal));
	signal.addEventListener("abort", abort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", abort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", abort);
			reject(error);
		},
	);
	return result;
}

export class LayaJudgeClient {
	#workers: RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse> | null = null;
	#unsubscribe: (() => void) | null = null;
	#workerRefed = false;
	#pending = new Map<string, LayaPending>();
	#nextRequestId = 0;
	#loaded = false;
	#loadPromise: Promise<void> | undefined;
	#loadState: LayaJudgeLoadState = "idle";
	#loadStateListeners = new Set<(state: LayaJudgeLoadState) => void>();
	#connect: () => Promise<RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse>>;

	constructor(options: LayaJudgeClientOptions = {}) {
		this.#connect = options.connect ?? (() => this.#connectDefault(options.runtimeDir ?? getLayaWorkerRuntimeDir()));
	}

	subscribeLoadState(listener: (state: LayaJudgeLoadState) => void): () => void {
		this.#loadStateListeners.add(listener);
		this.#notifyLoadState(listener, this.#loadState);
		return () => this.#loadStateListeners.delete(listener);
	}
	waitUntilReady(signal?: AbortSignal): Promise<void> {
		return this.#load(signal);
	}

	prewarm(): void {
		void this.waitUntilReady().catch(error => {
			logger.debug("laya: prewarm failed", { error: workerError(error).message });
		});
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options: JudgeOptions = {}): Promise<unknown> {
		await this.#load(options.signal);
		const response = await this.#request(
			{
				type: "judge",
				id: this.#requestId(),
				state: request.state,
				questions: request.questions,
			},
			"judge",
			options.signal,
		);
		if (response.type !== "judgment") {
			throw new Error(`laya: expected judgment response, got ${response.type}`);
		}
		return response.result;
	}

	async terminate(): Promise<void> {
		const worker = this.#workers;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		const error = new Error("laya worker terminated");
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#syncWorkerRef();
		this.#workers = null;
		this.#loaded = false;
		this.#loadPromise = undefined;
		this.#setLoadState("idle");
		this.#workerRefed = false;
		if (worker) await worker.terminate();
	}

	async #connectDefault(runtimeDir: string): Promise<RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse>> {
		const endpoint = layaWorkerEndpoint(runtimeDir);
		const logPath = layaWorkerLogPath(runtimeDir);
		const tag = `laya|${LAYA_VERSION}|${Bun.hash.crc32(LAYA_SERVER_SCRIPT).toString(16)}`;
		const launch: JsonlWorkerLaunch = {
			tag,
			async spawn(workerEndpoint, workerLogPath) {
				const python = await ensureLayaRuntime();
				const script = await stageRunnerScript("omp-laya", "py", LAYA_SERVER_SCRIPT);
				const cacheDir = getLayaModelCacheDir();
				const env = workerEnvFromParent({
					PYTHONUNBUFFERED: "1",
					PYTHONIOENCODING: "utf-8",
					CUDA_VISIBLE_DEVICES: "",
					USE_TF: "0",
					HF_HUB_DISABLE_PROGRESS_BARS: "1",
					HF_HOME: cacheDir,
					HF_HUB_CACHE: path.join(cacheDir, "hub"),
					TOKENIZERS_PARALLELISM: "false",
				});
				const idleSeconds = Number($env[LAYA_WORKER_IDLE_MS_ENV]) / 1000 || LAYA_WORKER_IDLE_MS / 1000;
				const command = [
					python,
					"-u",
					script,
					"--socket",
					workerEndpoint,
					"--tag",
					tag,
					"--repo",
					LAYA_REPOSITORY,
					"--subfolder",
					LAYA_SUBFOLDER,
					"--cache-dir",
					cacheDir,
					"--idle-seconds",
					String(idleSeconds),
				];
				return spawnDetachedJsonlWorker(command, undefined, env, workerLogPath);
			},
		};
		return connectJsonlWorker<LayaWorkerRequest, LayaWorkerResponse>(launch, {
			runtimeDir,
			endpoint,
			logPath,
			label: "laya worker",
			closedLabel: JSONL_WORKER_CLOSED,
			ignoredLogPrefixes: ["omp laya worker listening on "],
		});
	}

	#ensureWorker(): RefCountedWorkerHandle<LayaWorkerRequest, LayaWorkerResponse> {
		if (this.#workers) return this.#workers;
		const worker = new LazyJsonlWorkerHandle(() => this.#connect());
		const unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		const unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		this.#unsubscribe = () => {
			unsubscribeMessage();
			unsubscribeError();
		};
		this.#workers = worker;
		return worker;
	}

	#requestId(): string {
		return String(++this.#nextRequestId);
	}

	#request(request: LayaWorkerRequest, kind: LayaPending["kind"], signal?: AbortSignal): Promise<LayaWorkerResponse> {
		const { promise, resolve, reject } = Promise.withResolvers<LayaWorkerResponse>();
		if (signal?.aborted) {
			reject(abortError(signal));
			return promise;
		}
		const pending: LayaPending = { kind, resolve, reject };
		const abort = (): void => {
			if (!this.#pending.delete(request.id)) return;
			this.#syncWorkerRef();
			reject(abortError(signal!));
		};
		try {
			const worker = this.#ensureWorker();
			this.#pending.set(request.id, pending);
			this.#syncWorkerRef();
			signal?.addEventListener("abort", abort, { once: true });
			worker.send(request);
		} catch (error) {
			this.#pending.delete(request.id);
			this.#syncWorkerRef();
			reject(workerError(error));
		}
		return promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			if (this.#pending.delete(request.id)) this.#syncWorkerRef();
		});
	}

	#load(signal?: AbortSignal): Promise<void> {
		if (this.#loaded) return Promise.resolve();
		if (this.#loadPromise) return raceWithAbort(this.#loadPromise, signal);
		this.#setLoadState("loading");
		const loadPromise = this.#request({ type: "load", id: this.#requestId() }, "load", signal).then(response => {
			if (response.type !== "loaded") throw new Error(`laya: expected loaded response, got ${response.type}`);
			if (response.device !== "cpu") throw new Error(`laya: worker reported non-CPU device ${response.device}`);
			this.#loaded = true;
			this.#setLoadState("ready");
		});
		const tracked = loadPromise
			.catch(error => {
				if (this.#loadPromise === tracked) this.#setLoadState("failed");
				throw error;
			})
			.finally(() => {
				if (this.#loadPromise === tracked) this.#loadPromise = undefined;
			});
		this.#loadPromise = tracked;
		return tracked;
	}

	#handleMessage(message: LayaWorkerResponse): void {
		const candidate: unknown = message;
		if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.type !== "string") {
			this.#handleWorkerError(new Error("laya: malformed worker response"));
			return;
		}
		const pending = this.#pending.get(candidate.id);
		if (!pending) {
			if (candidate.type === "pong") return;
			return;
		}
		if (candidate.type === "pong") {
			this.#handleWorkerError(
				new Error(`laya: unexpected pong response for ${pending.kind} request ${candidate.id}`),
			);
			return;
		}
		if (candidate.type === "error") {
			if (typeof candidate.error !== "string") {
				this.#handleWorkerError(new Error(`laya: malformed error response for request ${candidate.id}`));
				return;
			}
			this.#pending.delete(candidate.id);
			this.#syncWorkerRef();
			pending.reject(new Error(candidate.error));
			return;
		}
		if (
			(pending.kind === "load" && (candidate.type !== "loaded" || typeof candidate.device !== "string")) ||
			(pending.kind === "judge" && (candidate.type !== "judgment" || !Object.hasOwn(candidate, "result")))
		) {
			this.#handleWorkerError(
				new Error(`laya: unexpected ${candidate.type} response for ${pending.kind} request ${candidate.id}`),
			);
			return;
		}
		this.#pending.delete(candidate.id);
		this.#syncWorkerRef();
		pending.resolve(message);
	}

	#handleWorkerError(error: Error): void {
		const loadInProgress = this.#loadPromise !== undefined;
		const worker = this.#workers;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#syncWorkerRef();
		this.#workers = null;
		this.#loaded = false;
		this.#loadPromise = undefined;
		this.#setLoadState(loadInProgress ? "failed" : "idle");
		this.#workerRefed = false;
		if (worker) void worker.terminate();
		if (error.message.startsWith(JSONL_WORKER_CLOSED)) {
			logger.debug("laya: worker went away while idle", { error: error.message });
		} else {
			logger.warn("laya: worker error", { error: error.message });
		}
	}

	#syncWorkerRef(): void {
		if (!this.#workers) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#workerRefed) return;
		this.#workerRefed = shouldRef;
		if (shouldRef) this.#workers.ref();
		else this.#workers.unref();
	}

	#notifyLoadState(listener: (state: LayaJudgeLoadState) => void, state: LayaJudgeLoadState): void {
		try {
			listener(state);
		} catch (error) {
			logger.debug("laya: load-state listener failed", { error: workerError(error).message });
		}
	}

	#setLoadState(state: LayaJudgeLoadState): void {
		if (this.#loadState === state) return;
		this.#loadState = state;
		for (const listener of this.#loadStateListeners) this.#notifyLoadState(listener, state);
	}
}

export const layaJudgeClient = new LayaJudgeClient();

export async function shutdownLayaJudgeClient(): Promise<void> {
	await layaJudgeClient.terminate();
}
