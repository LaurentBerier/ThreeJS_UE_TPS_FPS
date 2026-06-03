"""Local static server with correct MIME types for ES modules + WASM (Windows-safe).

The game is a buildless ES-module site, so .js MUST be served as
application/javascript and the Ammo .wasm as application/wasm, which Python's
`http.server -m` does not guarantee on Windows. Run this instead:

    python serve.py            # serves on http://127.0.0.1:8070

Set PORT to override. Auto-rolls forward if the port is busy.
"""
import errno
import http.server
import os
import socket
import socketserver

# ThreadingHTTPServer was added in Python 3.7. Build an equivalent from the
# mixin so the server still runs under older interpreters (e.g. a stray 3.6).
if hasattr(http.server, "ThreadingHTTPServer"):
    _ThreadingHTTPServer = http.server.ThreadingHTTPServer
else:
    class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

# Always serve the game folder, even if the shell cwd is elsewhere.
_ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(_ROOT)


def _requested_port() -> int:
    # 8070 so it can run alongside Polliniate (8080) / Zombie Blaster (8090).
    return int(os.environ.get("PORT", "8070"))


def _addr_in_use(err: OSError) -> bool:
    if err.errno == errno.EADDRINUSE:
        return True
    # Windows: 10048 (in use), 10013 (access denied / reserved range).
    if getattr(err, "winerror", None) in (10013, 10048):
        return True
    return False


# Register before Windows mimetypes: stdlib checks extensions_map first.
_extensions = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
_extensions.update(
    {
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".wasm": "application/wasm",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".fbx": "application/octet-stream",
        ".obj": "text/plain",
        ".json": "application/json",
    }
)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = _extensions

    def end_headers(self) -> None:
        # No-store during template development so freshly edited modules/assets
        # always reload (avoids stale-cache confusion while iterating).
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class _Server(_ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _bind_server(start_port: int, attempts: int = 30):
    last_err = None
    for p in range(start_port, start_port + attempts):
        try:
            return _Server(("", p), Handler), p
        except OSError as e:
            if _addr_in_use(e):
                last_err = e
                continue
            raise
    raise OSError(
        f"No free port in {start_port}-{start_port + attempts - 1}. "
        "Close the other server or set PORT to an open port."
    ) from last_err


if __name__ == "__main__":
    want = _requested_port()
    httpd, bound = _bind_server(want)
    with httpd:
        print()
        print("  ThreeJS UE TPS/FPS dev server")
        print("  (ES modules need application/javascript — do not use "
              "`python -m http.server` on Windows)")
        print(f"  Serving:  {_ROOT}")
        if bound != want:
            print(f"  Port {want} was busy — using {bound} instead.")
        print(f"  Game URL: http://127.0.0.1:{bound}/index.html")
        print()
        httpd.serve_forever()
