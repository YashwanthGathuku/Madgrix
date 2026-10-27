// Child process for one witness run: runContained is synchronous (spawnSync on its reaper),
// so the daemon runs it here to keep its event loop free and let repos promote in parallel.
import { runContained } from '../../../scripts/lib/sandbox.mjs';
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const spec = JSON.parse(buf);
  const r = runContained(spec);
  process.stdout.write(JSON.stringify({ status: r.status, signal: r.signal, timedOut: r.timedOut, sandbox: r.sandbox }));
});
