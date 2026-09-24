import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { connectJsonlWorker, probeJsonlWorker } from "@oh-my-pi/pi-coding-agent/subprocess/jsonl-worker";

const tempDirs: string[] = [];

async function listen(server: net.Server, endpoint: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(endpoint, () => {
		server.off("error", reject);
		resolve();
	});
	await promise;
}

async function close(server: net.Server): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.close(error => {
		if (error) reject(error);
		else resolve();
	});
	await promise;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("probeJsonlWorker", () => {
	test("contains a malformed handshake response instead of throwing from the socket callback", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jsonl-probe-"));
		tempDirs.push(directory);
		const endpoint =
			process.platform === "win32"
				? `\\\\.\\pipe\\omp-jsonl-probe-${process.pid}-${Bun.hash(directory).toString(16)}`
				: path.join(directory, "worker.sock");
		const server = net.createServer(socket => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				buffer += chunk;
				if (buffer.includes("\n")) socket.write("not-json\n");
			});
		});
		await listen(server, endpoint);

		try {
			const result = await probeJsonlWorker(endpoint, "expected-tag", "probe-test");
			expect(result.kind).toBe("invalid");
			if (result.kind === "invalid") expect(result.error.message).toContain("invalid probe response");
		} finally {
			await close(server);
		}
	});

	test("rejects a malformed endpoint without spawning over it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jsonl-probe-"));
		tempDirs.push(directory);
		const endpoint =
			process.platform === "win32"
				? `\\\\.\\pipe\\omp-jsonl-probe-${process.pid}-${Bun.hash(directory).toString(16)}`
				: path.join(directory, "worker.sock");
		const server = net.createServer(socket => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				buffer += chunk;
				if (buffer.includes("\n")) socket.write("not-json\n");
			});
		});
		await listen(server, endpoint);
		let spawnCount = 0;

		try {
			await expect(
				connectJsonlWorker(
					{
						tag: "expected-tag",
						spawn: async () => {
							spawnCount++;
							throw new Error("spawn should not run");
						},
					},
					{
						runtimeDir: directory,
						endpoint,
						logPath: path.join(directory, "worker.log"),
						label: "probe-test",
					},
				),
			).rejects.toThrow("invalid worker handshake");
			expect(spawnCount).toBe(0);
		} finally {
			await close(server);
		}
	});
});
