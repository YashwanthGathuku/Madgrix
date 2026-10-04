declare module "cloudflare:workers" {
	export interface WorkflowEvent<T = unknown> {
		payload: T;
		instanceId?: string;
	}
	export interface WorkflowStep {
		do<T>(name: string, fn: () => Promise<T>): Promise<T>;
		do<T>(
			name: string,
			options: Record<string, unknown>,
			fn: () => Promise<T>,
		): Promise<T>;
	}
	export abstract class WorkflowEntrypoint<E = unknown, P = unknown> {
		protected env: E;
		constructor(ctx: unknown, env: E);
		abstract run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<unknown>;
	}
}

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
	kill(signal?: number): void;
}
interface ContainerHandle {
	running: boolean;
	start(options?: { env?: Record<string, string>; entrypoint?: string[]; enableInternet?: boolean }): void;
	exec(cmd: string[], options?: { env?: Record<string, string> }): Promise<ContainerExecProcess>;
	destroy(error?: unknown): Promise<void>;
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

/** Structural stand-in for a Workflow instance handle. */
interface WorkflowInstanceHandle {
	id: string;
	status(): Promise<{ status: string; error?: { name: string; message: string }; output?: unknown }>;
	terminate(): Promise<void>;
	restart(): Promise<void>;
}

/** Structural stand-in for a Workflow binding (`Workflow` in the runtime types). */
interface WorkflowBindingLike {
	create(options?: { id?: string; params?: unknown }): Promise<WorkflowInstanceHandle>;
	get(id: string): Promise<WorkflowInstanceHandle>;
}

/** Worker environment (structural). In production, `ARTIFACTS` is the real
 *  Artifacts binding adapted via `BindingArtifactsPort`; locally it is a
 *  `FakeArtifacts` (which already implements `ArtifactsPort`). */
interface Env {
	ARTIFACTS: import("../lib/artifacts-port.ts").ArtifactsPort;
	TASK_AUTHORITY: DoNamespace;
	/** Secret used only at the Worker edge to authenticate evaluation-domain submissions. */
	EVALUATION_SERVICE_TOKEN: string;
	CONTROL_SERVICE_TOKEN: string;
	AGENT_SERVICE_TOKEN: string;
	/** Ed25519 PKCS8 (PEM or base64) the TaskAuthority signs promotion bundles with. */
	AUTHORITY_SIGNING_KEY?: string;
	PROMOTION_CONTAINER: DoNamespace;
	/** The PromotionWorkflow binding: one instance per permit, id = permit_id. */
	PROMOTION_WORKFLOW: WorkflowBindingLike;
}

/** Queue consumer batch shape (structural; mirrors MessageBatch). */
interface QueueBatchLike {
	/** Cloudflare Event Subscription messages arrive as product-defined envelopes. */
	messages: Array<{ body: unknown }>;
}
