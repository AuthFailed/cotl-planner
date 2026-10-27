"""Serve the exported Assets folder plus this folder, and accept PUT /bg/<name> to save output.
Usage: python3 serve.py <ExportedProject/Assets> <port>"""
import http.server, os, sys

ASSETS, PORT = os.path.abspath(sys.argv[1]), int(sys.argv[2])
HERE = os.path.dirname(os.path.abspath(__file__))

class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?")[0]
        from urllib.parse import unquote
        path = unquote(path)
        if path.startswith("/bg/"):
            return os.path.join(HERE, os.path.basename(path))
        return os.path.join(ASSETS, path.lstrip("/"))

    def do_PUT(self):
        if not self.path.startswith("/bg/"):
            return self.send_error(403)
        n = int(self.headers["Content-Length"])
        with open(os.path.join(HERE, os.path.basename(self.path.split("?")[0])), "wb") as f:
            f.write(self.rfile.read(n))
        self.send_response(204); self.end_headers()

    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
