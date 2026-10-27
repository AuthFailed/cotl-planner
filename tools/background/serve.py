"""Serve the exported Assets folder plus this folder, and accept PUT /bg/<path> to save output.
Usage: python3 serve.py <ExportedProject/Assets> <port>"""
import http.server, os, sys
from urllib.parse import unquote

ASSETS, PORT = os.path.realpath(sys.argv[1]), int(sys.argv[2])
HERE = os.path.dirname(os.path.realpath(__file__))


def within(base, rel):
    """Absolute path of rel under base, or None if it would escape base."""
    p = os.path.realpath(os.path.join(base, rel))
    return p if p == base or p.startswith(base + os.sep) else None


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(path.split("?")[0])
        if path.startswith("/bg/"):
            return within(HERE, path[4:]) or HERE + "/__denied__"
        return within(ASSETS, path.lstrip("/")) or ASSETS + "/__denied__"

    def do_PUT(self):
        path = unquote(self.path.split("?")[0])
        target = within(HERE, path[4:]) if path.startswith("/bg/") else None
        if not target:
            return self.send_error(403)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
