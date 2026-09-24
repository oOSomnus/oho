import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { $which, getTinyModelsCacheDir, getTinyWorkerRuntimeDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

/** Pinned Python package release for the local typed-decision adapter. */
export const LAYA_VERSION = "0.3.6";
/** Hugging Face repository containing the typed-decision checkpoint. */
export const LAYA_REPOSITORY = "convaiinnovations/laya";
/** Specialized checkpoint selected for approval decisions. */
export const LAYA_SUBFOLDER = "typed-decisions";
/** Private runtime Python range supported by the upstream package. */
const LAYA_PYTHON_SPEC = ">=3.10,<3.14";
const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
const PYPI_INDEX = "https://pypi.org/simple";
const PYTORCH_SPEC = "torch>=2.0";
const READY_MARKER = ".omp-laya";

export function getLayaRuntimeDir(): string {
	return path.join(path.dirname(getTinyModelsCacheDir()), "laya-runtime", `laya-${LAYA_VERSION}`);
}

export function getLayaModelCacheDir(): string {
	return path.join(getTinyModelsCacheDir(), "laya");
}

export function getLayaWorkerRuntimeDir(): string {
	return path.join(path.dirname(getTinyWorkerRuntimeDir()), "laya");
}

function venvPython(runtimeDir: string): string {
	const binDir = process.platform === "win32" ? "Scripts" : "bin";
	const executable = process.platform === "win32" ? "python.exe" : "python";
	return path.join(runtimeDir, binDir, executable);
}

async function readReadyMarker(runtimeDir: string): Promise<string | null> {
	try {
		return (await Bun.file(path.join(runtimeDir, READY_MARKER)).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function installWithUv(uv: string, runtimeDir: string): Promise<void> {
	const venv = await $`${uv} venv --quiet --python ${LAYA_PYTHON_SPEC} ${runtimeDir}`.quiet().nothrow();
	if (venv.exitCode !== 0) throw new Error(`uv venv failed (exit ${venv.exitCode}): ${venv.stderr.toString().trim()}`);
	const python = venvPython(runtimeDir);
	const torch = await $`${uv} pip install --quiet --python ${python} --index-url ${PYTORCH_CPU_INDEX} ${PYTORCH_SPEC}`
		.quiet()
		.nothrow();
	if (torch.exitCode !== 0) {
		throw new Error(`uv CPU torch install failed (exit ${torch.exitCode}): ${torch.stderr.toString().trim()}`);
	}
	const laya = await $`${uv} pip install --quiet --python ${python} --index-url ${PYPI_INDEX} laya==${LAYA_VERSION}`
		.quiet()
		.nothrow();
	if (laya.exitCode !== 0) {
		throw new Error(`uv Laya install failed (exit ${laya.exitCode}): ${laya.stderr.toString().trim()}`);
	}
}

async function installWithSystemPython(python3: string, runtimeDir: string): Promise<void> {
	const check = await $`${python3} -c ${"import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)"}`
		.quiet()
		.nothrow();
	if (check.exitCode !== 0) {
		throw new Error(`${python3} is outside the supported Python range 3.10-3.13; install uv or another Python`);
	}
	const venv = await $`${python3} -m venv ${runtimeDir}`.quiet().nothrow();
	if (venv.exitCode !== 0) {
		throw new Error(`python3 -m venv failed (exit ${venv.exitCode}): ${venv.stderr.toString().trim()}`);
	}
	const python = venvPython(runtimeDir);
	const torch =
		await $`${python} -m pip install --quiet --disable-pip-version-check --index-url ${PYTORCH_CPU_INDEX} ${PYTORCH_SPEC}`
			.quiet()
			.nothrow();
	if (torch.exitCode !== 0) {
		throw new Error(`pip CPU torch install failed (exit ${torch.exitCode}): ${torch.stderr.toString().trim()}`);
	}
	const laya =
		await $`${python} -m pip install --quiet --disable-pip-version-check --index-url ${PYPI_INDEX} laya==${LAYA_VERSION}`
			.quiet()
			.nothrow();
	if (laya.exitCode !== 0) {
		throw new Error(`pip Laya install failed (exit ${laya.exitCode}): ${laya.stderr.toString().trim()}`);
	}
}

/** Ensure the pinned CPU-only Python runtime and return its interpreter path. */
export async function ensureLayaRuntime(): Promise<string> {
	const runtimeDir = getLayaRuntimeDir();
	if ((await readReadyMarker(runtimeDir)) === LAYA_VERSION) return venvPython(runtimeDir);
	await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
	return withFileLock(`${runtimeDir}.install`, async () => {
		if ((await readReadyMarker(runtimeDir)) === LAYA_VERSION) return venvPython(runtimeDir);
		const uv = $which("uv");
		if (uv) {
			await installWithUv(uv, runtimeDir);
		} else {
			const python3 = $which("python3") ?? $which("python");
			if (!python3) throw new Error("Laya needs `uv` or Python 3.10-3.13 on PATH for its CPU runtime");
			await installWithSystemPython(python3, runtimeDir);
		}
		await Bun.write(path.join(runtimeDir, READY_MARKER), `${LAYA_VERSION}\n`);
		return venvPython(runtimeDir);
	});
}
