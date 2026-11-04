#!/usr/bin/python3 -I
# g4a system-mode peer gate. Node has no SO_PEERCRED, so this tiny stdlib-only helper owns the
# shared socket: for every connection it reads the kernel-reported peer uid (SO_PEERCRED, which the
# client cannot forge) and forwards ONE request line to the authority server (its parent, over a
# pipe) tagged with that uid. The caller's uid comes only from the kernel, never from the request.
# Protocol to parent (stdout): {"c": n, "uid": u, "line": "..."}; from parent (stdin): {"c": n, "reply": "..."}.
import json, os, socket, struct, sys, threading
MAX_LINE = 1 << 20
path = sys.argv[1]
slots = threading.BoundedSemaphore(4096)  # global cap on reading connections
PER_UID = 64  # per-uid cap: one user cannot starve the others (slowloris)
per_uid = {}
conns, lock, out_lock, n = {}, threading.Lock(), threading.Lock(), [0]

def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()

def handle(c):
    try:
        pid, uid, gid = struct.unpack("3i", c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        with lock:
            if per_uid.get(uid, 0) >= PER_UID:
                c.sendall(b'{"error":"busy"}\n'); c.close(); return
            per_uid[uid] = per_uid.get(uid, 0) + 1
        try: line = read_line(c)
        finally:
            with lock: per_uid[uid] -= 1
        if line is None: return
        with lock:
            n[0] += 1; k = n[0]; conns[k] = c
        emit({"c": k, "uid": uid, "line": line})
    except Exception:
        try: c.close()
        except Exception: pass

def read_line(c):
    try:
        c.settimeout(10)
        buf = b""
        while b"\n" not in buf:
            d = c.recv(65536)
            if not d: c.close(); return None
            buf += d
            if len(buf) > MAX_LINE:
                c.sendall(b'{"error":"request too large"}\n'); c.close(); return None
        c.settimeout(None)
        return buf.split(b"\n", 1)[0].decode("utf-8", "replace")
    except Exception:
        try: c.close()
        except Exception: pass
        return None

def replies():
    for raw in sys.stdin:
        try: m = json.loads(raw)
        except Exception: continue
        with lock: c = conns.pop(m.get("c"), None)
        if c is None: continue
        try: c.sendall(m["reply"].encode() + b"\n")
        except Exception: pass
        try: c.close()
        except Exception: pass
    os._exit(0)  # parent gone

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
old = os.umask(0o111)
s.bind(path)
os.umask(old)
os.chmod(path, 0o666)  # any local uid may connect; identity is the kernel peer uid
s.listen(256)
emit({"ready": True})
threading.Thread(target=replies, daemon=True).start()
while True:
    c, _ = s.accept()
    if not slots.acquire(blocking=False):
        try: c.sendall(b'{"error":"busy"}\n'); c.close()
        except Exception: pass
        continue
    def run(c=c):
        try: handle(c)
        finally: slots.release()
    threading.Thread(target=run, daemon=True).start()
