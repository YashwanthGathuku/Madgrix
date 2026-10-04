/**
 * An in-memory stand-in for a Cloudflare Workflow binding, for tests only. It
 * is not the Workflows runtime:
 *
 * - create() refuses an id that already has an instance, as the platform does;
 * - an instance runs only when drain() is called;
 * - step.do re-runs a throwing callback up to the step's `retries.limit`, with
 *   no delay between attempts;
 * - terminate() stops a queued or running instance;
 * - restart() queues an instance again (its attempts keep counting).
 */

export interface FakeInstanceState {
	status: "queued" | "running" | "complete" | "errored" | "terminated";
	output?: unknown;
	error?: { name: string; message: string };
}

interface Entrypoint {
	run(event: { payload: unknown; instanceId: string }, step: unknown): Promise<unknown>;
}

export class FakeWorkflow {
	readonly instances = new Map<string, { id: string; params: unknown; state: FakeInstanceState; attempts: number }>();
	createCalls = 0;
	private readonly entrypoint: () => Entrypoint;

	constructor(entrypoint: () => Entrypoint) {
		this.entrypoint = entrypoint;
	}

	async create(options: { id?: string; params?: unknown } = {}) {
		this.createCalls++;
		const id = options.id ?? crypto.randomUUID();
		if (this.instances.has(id)) throw new Error(`instance.already_exists: ${id}`);
		this.instances.set(id, { id, params: structuredClone(options.params), state: { status: "queued" }, attempts: 0 });
		return this.handle(id);
	}

	async get(id: string) {
		if (!this.instances.has(id)) throw new Error(`instance.not_found: ${id}`);
		return this.handle(id);
	}

	private handle(id: string) {
		const instance = this.instances.get(id)!;
		return {
			id,
			status: async (): Promise<FakeInstanceState> => structuredClone(instance.state),
			terminate: async () => {
				if (instance.state.status !== "queued" && instance.state.status !== "running") {
					throw new Error(`instance.not_running: ${id}`);
				}
				instance.state = { status: "terminated" };
			},
			restart: async () => {
				instance.state = { status: "queued" };
			},
		};
	}

	/** Run every queued instance to the end. */
	async drain(): Promise<void> {
		for (const instance of this.instances.values()) {
			if (instance.state.status !== "queued") continue;
			instance.state = { status: "running" };
			const step = {
				do: async (_name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) => {
					const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<unknown>;
					const config = (typeof configOrFn === "function" ? {} : configOrFn) as { retries?: { limit?: number } };
					const limit = config.retries?.limit ?? 0;
					for (let attempt = 0; ; attempt++) {
						instance.attempts++;
						try {
							return await fn();
						} catch (err) {
							if (attempt >= limit) throw err;
						}
					}
				},
			};
			try {
				const output = await this.entrypoint().run({ payload: structuredClone(instance.params), instanceId: instance.id }, step);
				if (instance.state.status === "running") instance.state = { status: "complete", output: structuredClone(output) };
			} catch (err) {
				if (instance.state.status === "running") {
					instance.state = { status: "errored", error: { name: (err as Error).name, message: (err as Error).message } };
				}
			}
		}
	}
}
