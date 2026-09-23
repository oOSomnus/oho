import * as path from "node:path";
import type { JudgmentState, Questions } from "@oh-my-pi/pi-ai";

const LAYA_WORKER_NAME = "typed-decisions";
export const LAYA_WORKER_IDLE_MS_ENV = "OMP_LAYA_WORKER_IDLE_MS";
export const LAYA_WORKER_IDLE_MS = 15 * 60 * 1_000;

export type LayaWorkerRequest =
	| { type: "ping"; id: string }
	| { type: "load"; id: string }
	| { type: "judge"; id: string; state: JudgmentState; questions: Questions }
	| { type: "shutdown"; id: string };

export type LayaWorkerResponse =
	| { type: "pong"; id: string; tag: string }
	| { type: "loaded"; id: string; device: string }
	| { type: "judgment"; id: string; result: unknown }
	| { type: "error"; id: string; error: string };

export function layaWorkerEndpoint(runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.crc32(path.resolve(runtimeDir, LAYA_WORKER_NAME)).toString(16).padStart(8, "0");
		return `\\\\.\\pipe\\omp-laya-${LAYA_WORKER_NAME}-${key}`;
	}
	return path.join(runtimeDir, `${LAYA_WORKER_NAME}.sock`);
}

export function layaWorkerLogPath(runtimeDir: string): string {
	return path.join(runtimeDir, `${LAYA_WORKER_NAME}.log`);
}
