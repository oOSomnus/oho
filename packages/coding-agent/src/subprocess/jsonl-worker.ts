import * as fs from "node:fs";
import type * as net from "node:net";
import type { Subprocess } from "bun";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { connectJsonlSocket, LineParser, writeJsonLine } from "../tiny/jsonl-socket";
import type { RefCountedWorkerHandle } from "./worker-client";

export const JSONL_WORKER_CLOSED = "jsonl worker connection closed";
export const CONNECT_TIMEOUT_MS = 3_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_INTERVAL_MS = 200;
/** Time for a spawned worker to bind its socket; Python side-runtimes can install first. */
export const READY_TIMEOUT_MS = 120_000;
/** Time for a stale worker to honour `shutdown` and release its socket. */
export const SHUTDOWN_WAIT_MS = 5_000;

export interface JsonlWorkerLaunch {
	tag: string;
	spawn(endpoint: string, logPath: string): Promise<JsonlWorkerProcess>;
}

export interface JsonlWorkerProcess {
	proc: Subprocess;
	logPath: string;
}

export type JsonlWorkerProbeResult =
	| { kind: "live"; socket: net.Socket }
	| { kind: "stale" }
	| { kind: "absent" }
	| { kind: "invalid"; error: Error };

type ProbePong<Outbound extends { type: string }> = Outbound & { type: "pong"; id: string; tag: string };

function isProbePong<Outbound extends { type: string }>(value: unknown): value is ProbePong<Outbound> {
	return isRecord(value) && value.type === "pong" && typeof value.id === "string" && typeof value.tag === "string";
}

function createSocketWorkerHandle<Inbound, Outbound>(
	socket: net.Socket,
	logPath: string,
	closedLabel: string,
): RefCountedWorkerHandle<Inbound, Outbound> {
	const messages = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	let terminated = false;
	const parser = new LineParser(line => {
		try {
			const message = JSON.parse(line) as Outbound;
			for (const handler of messages) handler(message);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			for (const handler of errors) handler(new Error(`${closedLabel}: invalid JSON response`, { cause: failure }));
		}
	});
	socket.on("data", (chunk: string) => parser.push(chunk));
	socket.once("close", () => {
		if (terminated) return;
		void readWorkerLogTail(logPath).then(tail => {
			const error = new Error(tail ? `${closedLabel}: ${tail}` : closedLabel);
			for (const handler of errors) handler(error);
		});
	});
	return {
		send(message) {
			writeJsonLine(socket, message);
		},
		onMessage(handler) {
			messages.add(handler);
			return () => messages.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		terminate() {
			terminated = true;
			socket.destroy();
			return Promise.resolve();
		},
		ref() {
			socket.ref();
		},
		unref() {
			socket.unref();
		},
	};
}

export class LazyJsonlWorkerHandle<Inbound, Outbound> implements RefCountedWorkerHandle<Inbound, Outbound> {
	#inner: RefCountedWorkerHandle<Inbound, Outbound> | null = null;
	#queue: Inbound[] = [];
	#messages = new Set<(message: Outbound) => void>();
	#errors = new Set<(error: Error) => void>();
	#refed = false;
	#terminated = false;

	constructor(connect: () => Promise<RefCountedWorkerHandle<Inbound, Outbound>>) {
		connect().then(
			inner => {
				if (this.#terminated) {
					void inner.terminate();
					return;
				}
				this.#inner = inner;
				inner.onMessage(message => {
					for (const handler of this.#messages) handler(message);
				});
				inner.onError(error => {
					for (const handler of this.#errors) handler(error);
				});
				if (this.#refed) inner.ref();
				else inner.unref();
				const queued = this.#queue;
				this.#queue = [];
				for (const message of queued) inner.send(message);
			},
			error => {
				if (this.#terminated) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				for (const handler of this.#errors) handler(failure);
			},
		);
	}

	send(message: Inbound): void {
		if (this.#inner) this.#inner.send(message);
		else this.#queue.push(message);
	}

	onMessage(handler: (message: Outbound) => void): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	terminate(): Promise<void> {
		this.#terminated = true;
		this.#queue = [];
		return this.#inner?.terminate() ?? Promise.resolve();
	}

	ref(): void {
		this.#refed = true;
		this.#inner?.ref();
	}

	unref(): void {
		this.#refed = false;
		this.#inner?.unref();
	}
}

/** Spawn a detached worker whose stdout/stderr go to its per-worker log. */
export function spawnDetachedJsonlWorker(
	cmd: string[],
	cwd: string | undefined,
	env: Record<string, string>,
	logPath: string,
): JsonlWorkerProcess {
	const log = fs.openSync(logPath, "w");
	try {
		const proc = Bun.spawn({
			cmd,
			cwd,
			env,
			detached: true,
			stdin: "ignore",
			stdout: log,
			stderr: log,
			windowsHide: true,
		});
		proc.unref();
		return { proc, logPath };
	} finally {
		fs.closeSync(log);
	}
}

export async function probeJsonlWorker<Inbound extends { type: string; id: string }, Outbound extends { type: string }>(
	endpoint: string,
	tag: string,
	label: string,
): Promise<JsonlWorkerProbeResult> {
	let socket: net.Socket | undefined;
	try {
		socket = await connectJsonlSocket(endpoint, CONNECT_TIMEOUT_MS);
		const outcome = Promise.withResolvers<
			{ kind: "reply"; reply: ProbePong<Outbound> } | { kind: "closed" } | { kind: "invalid"; error: Error }
		>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		function cleanup(): void {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			socket?.off("data", onData);
			socket?.off("close", onClose);
		}
		function settle(
			value: { kind: "reply"; reply: ProbePong<Outbound> } | { kind: "closed" } | { kind: "invalid"; error: Error },
		): void {
			if (settled) return;
			settled = true;
			cleanup();
			outcome.resolve(value);
		}
		function onData(chunk: string): void {
			parser.push(chunk);
		}
		function onClose(): void {
			settle({ kind: "closed" });
		}
		const parser = new LineParser(line => {
			try {
				const parsed: unknown = JSON.parse(line);
				if (!isProbePong<Outbound>(parsed)) throw new Error("expected pong with string id and tag");
				settle({ kind: "reply", reply: parsed });
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				settle({ kind: "invalid", error: new Error(`${label}: invalid probe response`, { cause: failure }) });
			}
		});
		timer = setTimeout(() => settle({ kind: "closed" }), PROBE_TIMEOUT_MS);
		socket.on("data", onData);
		socket.once("close", onClose);
		try {
			writeJsonLine(socket, { type: "ping", id: "probe" } as Inbound);
		} catch (error) {
			cleanup();
			socket.destroy();
			throw error;
		}
		const result = await outcome.promise;
		if (result.kind === "invalid") {
			socket.destroy();
			return result;
		}
		if (result.kind === "closed") {
			socket.destroy();
			return { kind: "absent" };
		}
		if (result.reply.tag === tag) return { kind: "live", socket };
		logger.debug(`${label}: worker launch tag mismatch; replacing`, {
			endpoint,
			running: result.reply.tag,
			expected: tag,
		});
		writeJsonLine(socket, { type: "shutdown", id: "replace" } as Inbound);
		socket.destroy();
		return { kind: "stale" };
	} catch {
		socket?.destroy();
		return { kind: "absent" };
	}
}

export async function waitForJsonlWorkerRelease<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(endpoint: string, label: string): Promise<void> {
	const deadline = Date.now() + SHUTDOWN_WAIT_MS;
	while (Date.now() < deadline) {
		const result = await probeJsonlWorker<Inbound, Outbound>(endpoint, "", label);
		if (result.kind === "absent") return;
		if (result.kind === "invalid") {
			logger.warn(`${label}: worker handshake remained invalid while waiting for release`, {
				endpoint,
				error: result.error.message,
			});
			throw new Error(`${label}: invalid worker handshake at ${endpoint}`, { cause: result.error });
		}
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
}

/** Last 500 chars of a worker log, excluding readiness banners. */
export async function readWorkerLogTail(logPath: string, ignoredPrefixes: readonly string[] = []): Promise<string> {
	try {
		const text = await Bun.file(logPath).text();
		return text
			.split("\n")
			.filter(line => !ignoredPrefixes.some(prefix => line.startsWith(prefix)))
			.join("\n")
			.trim()
			.slice(-500);
	} catch {
		return "";
	}
}

export async function connectJsonlWorker<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(
	launch: JsonlWorkerLaunch,
	options: {
		runtimeDir: string;
		endpoint: string;
		logPath: string;
		label: string;
		closedLabel?: string;
		ignoredLogPrefixes?: readonly string[];
	},
): Promise<RefCountedWorkerHandle<Inbound, Outbound>> {
	await fs.promises.mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
	const failInvalidProbe = (result: JsonlWorkerProbeResult): never => {
		if (result.kind !== "invalid") throw new Error("unreachable invalid probe result");
		logger.warn(`${options.label}: worker handshake rejected`, {
			endpoint: options.endpoint,
			error: result.error.message,
		});
		throw new Error(`${options.label}: invalid worker handshake at ${options.endpoint}`, { cause: result.error });
	};
	const probed = await probeJsonlWorker<Inbound, Outbound>(options.endpoint, launch.tag, options.label);
	if (probed.kind === "invalid") failInvalidProbe(probed);
	if (probed.kind === "live") {
		return createSocketWorkerHandle(
			probed.socket,
			options.logPath,
			options.closedLabel ?? `${options.label} connection closed`,
		);
	}
	if (probed.kind === "stale") await waitForJsonlWorkerRelease<Inbound, Outbound>(options.endpoint, options.label);
	const spawned = await launch.spawn(options.endpoint, options.logPath);
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const result = await probeJsonlWorker<Inbound, Outbound>(options.endpoint, launch.tag, options.label);
		if (result.kind === "invalid") {
			try {
				spawned.proc.kill();
			} catch {
				// The worker may have exited while the probe was reading its response.
			}
			failInvalidProbe(result);
		}
		if (result.kind === "live") {
			return createSocketWorkerHandle(
				result.socket,
				options.logPath,
				options.closedLabel ?? `${options.label} connection closed`,
			);
		}
		if (spawned.proc.exitCode !== null) {
			const tail = await readWorkerLogTail(options.logPath, options.ignoredLogPrefixes);
			throw new Error(`${options.label} exited with code ${spawned.proc.exitCode}${tail ? `: ${tail}` : ""}`);
		}
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
	throw new Error(`${options.label} did not bind ${options.endpoint} within ${READY_TIMEOUT_MS}ms`);
}
