import { describe, expect, it } from "bun:test";
import { LayaLane, LayaLaneDroppedError } from "../../src/judgment/laya-lane";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("LayaLane", () => {
	it("runs one job at a time and preserves submission order", async () => {
		const lane = new LayaLane({ timeoutMs: 1_000 });
		let running = 0;
		let maxRunning = 0;
		const order: string[] = [];

		const run = (name: string, ms: number) =>
			lane.submit(async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await sleep(ms);
				order.push(name);
				running -= 1;
				return name;
			});

		const results = await Promise.all([run("one", 30), run("two", 5), run("three", 1)]);

		expect(maxRunning).toBe(1);
		expect(results).toEqual(["one", "two", "three"]);
		expect(order).toEqual(["one", "two", "three"]);
	});

	it("sheds instead of queueing without bound", async () => {
		const lane = new LayaLane({ timeoutMs: 1_000, queueLimit: 1 });
		const blocker = deferred<string>();

		const first = lane.submit(() => blocker.promise);
		const second = lane.submit(async () => "second");
		const third = lane.submit(async () => "third");

		await expect(third).rejects.toBeInstanceOf(LayaLaneDroppedError);
		blocker.resolve("first");
		expect(await first).toBe("first");
		expect(await second).toBe("second");
	});

	it("settles a job that outruns its budget and aborts it", async () => {
		const lane = new LayaLane({ timeoutMs: 20 });
		let sawAbort = false;

		const pending = lane.submit(async signal => {
			signal.addEventListener("abort", () => {
				sawAbort = true;
			});
			await sleep(200);
			return "too late";
		});

		await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
		expect(sawAbort).toBe(true);
		expect(lane.depth).toBe(0);
	});

	it("counts queue wait against the job's budget", async () => {
		const lane = new LayaLane({ timeoutMs: 120, queueLimit: 2 });

		const first = lane.submit(async () => {
			await sleep(100);
			return "first";
		});
		// Queued behind `first`, so it only gets the tail of the shared budget.
		// Were queue wait excluded it would finish comfortably inside 120ms.
		const queued = lane.submit(async () => {
			await sleep(100);
			return "queued";
		});

		expect(await first).toBe("first");
		await expect(queued).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("recovers after a failure and keeps taking work", async () => {
		const lane = new LayaLane({ timeoutMs: 1_000 });

		await expect(
			lane.submit(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await lane.submit(async () => "still here")).toBe("still here");
	});
});
