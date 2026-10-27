// Test-only: a daemon whose promotion SIGKILLs itself at a chosen point (afterIntent | afterCas).
// Production code has no crash switches; this injects them through startDaemon({ hooks }).
import { startDaemon } from '../../src/daemon.mjs';
const point = process.argv[2];
const d = await startDaemon(process.env.G4A_HOME, { hooks: { [point]: () => process.kill(process.pid, 'SIGKILL') } });
console.error(`g4a daemon pid ${process.pid} on ${d.sock} (crash at ${point})`);
