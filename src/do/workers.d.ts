/**
 * Minimal ambient declarations for the Durable Object / Worker edge.
 *
 * @cloudflare/workers-types is NOT vendored in this project, so these
 * structural declarations stand in for it. PRODUCTION MUST use the real
 * types from "cloudflare:workers" (or @cloudflare/workers-types):
 *   - `DurableObjectState` / `DurableObjectEnv` here are strict subsets of
 *     the real interfaces (only the members this platform layer uses).
 *   - The `declare class DurableObject` is provided for completeness; the
 *     TaskAuthority class below intentionally does NOT extend it (no real
 *     base class is importable here) and instead uses structural typing —
 *     the runtime only requires the `(state, env)` constructor shape and a
 *     `fetch(request)` method.
 *   - `Env` is the Worker's environment: the Artifacts port abstraction
 *     plus the task-authority Durable Object namespace (structural).
 */
interface ContainerExecOutput {
	exitCode: number;
	stdout: ArrayBuffer;
	stderr: ArrayBuffer;
}
interface ContainerExecProcess {
	output(): Promise<ContainerExecOutput>;
}
interface ContainerHandle {
	running: boolean;
	start(options?: { env?: Record<string, string>; entrypoint?: string[]; enableInternet?: boolean }): void;
	exec(cmd: string[], options?: { env?: Record<string, string> }): Promise<ContainerExecProcess>;
}

interface DurableObjectState {
	container?: ContainerHandle;
	storage: {
		get<T>(k: string): Promise<T | undefined>;
		put<T>(k: string, v: T): Promise<void>;
		transaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T>;
	};
	id: { toString(): string };
}

interface DurableObjectEnv {
	[k: string]: unknown;
}

declare class DurableObject {
	constructor(state: DurableObjectState, env: DurableObjectEnv);
}

/** Structural stand-in for DurableObjectId. */
interface DoObjectId {
	toString(): string;
}

/** Structural stand-in for a Durable Object stub (fetch RPC). */
interface DoStub {
	fetch(r: Request): Promise<Response>;
}

/** Structural stand-in for a Durable Object namespace. */
interface DoNamespace {
	idFromName(name: string): DoObjectId;
	get(id: DoObjectId): DoStub;
}

/** Worker environment (structural). In production, `ARTIFACTS` is the real
 *  Artifacts binding adapted via `BindingArtifactsPort`; locally it is a
 *  `FakeArtifacts` (which already implements `ArtifactsPort`). */
interface Env {
	ARTIFACTS: import("../lib/artifacts-port.ts").ArtifactsPort;
	TASK_AUTHORITY: DoNamespace;
	/** Secret used only at the Worker edge to authenticate evaluation-domain submissions. */
	EVALUATION_SERVICE_TOKEN: string;
	PROMOTION_CONTAINER: DoNamespace;
}

/** Queue consumer batch shape (structural; mirrors MessageBatch). */
interface QueueBatchLike {
	messages: Array<{ body: { task_id: string; event: import("../lib/types.ts").QueuePushEvent } }>;
}
