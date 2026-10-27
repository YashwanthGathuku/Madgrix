/** In-memory DurableObjectState for ModuleAgent tests and the demo. */
export function memoryState(): DurableObjectState & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		id: { toString: () => "memory" },
		storage: {
			async get<T>(k: string) {
				return data.has(k) ? (structuredClone(data.get(k)) as T) : undefined;
			},
			async put<T>(k: string, v: T) {
				data.set(k, structuredClone(v));
			},
			async transaction<T>(fn: (txn: unknown) => Promise<T>) {
				return fn(null);
			},
		},
	};
}
