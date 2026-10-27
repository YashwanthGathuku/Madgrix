/// <reference types="node" />
/** worker_threads entry for readParallel(): one module per message. */
import { parentPort, workerData } from "node:worker_threads";
import { readModule, type ReadJob } from "./module-reader.ts";

const { repo, sha } = workerData as { repo: string; sha: string };
parentPort!.on("message", async (job: ReadJob) => {
	try {
		parentPort!.postMessage({ card: await readModule(repo, sha, job) });
	} catch (err) {
		parentPort!.postMessage({ error: (err as Error).message });
	}
});
