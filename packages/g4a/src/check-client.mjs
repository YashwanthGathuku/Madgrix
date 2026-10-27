// Minimal socket client for the shim (no sqlite import, so no startup cost or warnings).
import net from 'node:net';
import path from 'node:path';
export function checkWithDaemon(params, { home, timeoutMs = 500 }) {
  return new Promise((resolve) => {
    const c = net.connect(path.join(home, 'g4a.sock'));
    let buf = '';
    const done = (v) => { clearTimeout(t); c.destroy(); resolve(v); };
    const t = setTimeout(() => done({ unavailable: 'timeout' }), timeoutMs);
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method: 'check', params }) + '\n'));
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i < 0) return; try { const r = JSON.parse(buf.slice(0, i)); done(r.error ? { unavailable: r.error } : r.result); } catch { done({ unavailable: 'bad reply' }); } });
    c.on('error', (e) => done({ unavailable: e.code || e.message }));
  });
}
