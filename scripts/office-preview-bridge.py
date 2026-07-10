#!/usr/bin/env python
from __future__ import print_function

import os
import select
import socket

try:
    import socketserver
except ImportError:
    import SocketServer as socketserver


LISTEN_HOST = os.environ.get('OFFICE_BRIDGE_LISTEN_HOST', '172.17.0.1')
LISTEN_PORT = int(os.environ.get('OFFICE_BRIDGE_LISTEN_PORT', '18092'))
TARGET_HOST = os.environ.get('OFFICE_BRIDGE_TARGET_HOST', '127.0.0.1')
TARGET_PORT = int(os.environ.get('OFFICE_BRIDGE_TARGET_PORT', '18091'))


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=10)
        try:
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    continue
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    destination = upstream if source is self.request else self.request
                    destination.sendall(data)
        finally:
            upstream.close()


class ThreadedTcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    server = ThreadedTcpServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    print(
        'Office preview bridge listening on %s:%s -> %s:%s'
        % (LISTEN_HOST, LISTEN_PORT, TARGET_HOST, TARGET_PORT)
    )
    server.serve_forever()
