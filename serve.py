"""
Development server for the Digital Leaders map.

Use this rather than `python -m http.server`. The built-in server sends a
Last-Modified header but no Cache-Control, so browsers fall back to heuristic
caching and happily reuse index.js and tokens.css without revalidating. The
symptom is edits that appear to have no effect: the HTML updates, the
JavaScript does not, and the page shows a half-old interface.

This sends `Cache-Control: no-store` on everything, so every reload fetches
the current file.

Usage:
    python serve.py            # http://localhost:8000
    python serve.py 8080       # another port
"""

import io
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


ASSET_PATTERN = re.compile(r'(src|href)="(\./[^"?]+\.(?:js|css))"')


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_head(self):
        """
        Serve index.html with a version stamp on every local script and
        stylesheet.

        No-cache headers alone are not enough: they only apply to responses
        the browser actually requests, and an entry cached BEFORE those
        headers existed stays "fresh" on its old heuristic. The browser then
        reuses index.js without asking, and edits appear to do nothing while
        the HTML updates around them.

        Stamping each URL with the file's modification time sidesteps caching
        entirely — a changed file becomes a different URL, which no cache can
        have. index.html itself is never cached, so the new URLs are always
        seen.
        """
        path = self.translate_path(self.path)
        if not path.endswith('index.html') or not os.path.exists(path):
            return super().send_head()

        with open(path, encoding='utf-8') as handle:
            page = handle.read()

        def stamp(match):
            attr, url = match.group(1), match.group(2)
            local = os.path.join(HERE, url.lstrip('./').replace('/', os.sep))
            version = int(os.path.getmtime(local)) if os.path.exists(local) else 0
            return '%s="%s?v=%d"' % (attr, url, version)

        body = ASSET_PATTERN.sub(stamp, page).encode('utf-8')

        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def log_message(self, fmt, *args):
        # Quieter than the default: only report anything that is not a 200.
        status = str(args[1]) if len(args) > 1 else ''
        if not status.startswith('2'):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

    # Threaded, not the single-threaded HTTPServer: a browser holding one
    # connection open blocks every other request on a single-threaded server,
    # which looks exactly like the server being down.
    server = ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler)
    server.daemon_threads = True
    print('serving %s' % HERE)
    print('  http://localhost:%d/index.html' % port)
    print('  caching disabled and asset URLs version-stamped —')
    print('  a plain reload always gets the current files')
    print('  Ctrl+C to stop')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()
