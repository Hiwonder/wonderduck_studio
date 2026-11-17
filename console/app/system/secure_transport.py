"""Provide HTTPS access to the existing Studio, control and media listeners."""

import ipaddress
import logging
import os
from pathlib import Path
import select
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading


SECURE_STUDIO_PORT = 9443
SECURE_CONTROL_PORT = 9444
SECURE_MEDIA_PORT = 9445


def _certificate(directory):
    """Create one private certificate per installation and reuse it on subsequent starts."""
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    certificate, key = directory / "certificate.pem", directory / "private-key.pem"
    if certificate.is_file() and key.is_file():
        return certificate, key
    if certificate.exists() or key.exists():
        raise RuntimeError(f"HTTPS 证书不完整：{directory}")

    result = subprocess.run(["hostname", "-I"], check=True, capture_output=True, text=True)
    addresses = {"127.0.0.1"}
    for value in result.stdout.split():
        addresses.add(str(ipaddress.ip_address(value.split("%", 1)[0])))
    subject_alt_names = ["DNS:localhost"] + [f"IP:{address}" for address in sorted(addresses)]
    hostname = socket.gethostname()
    if hostname and all(character.isalnum() or character in ".-" for character in hostname):
        subject_alt_names.extend((f"DNS:{hostname}", f"DNS:{hostname}.local"))
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        temporary = Path(temporary)
        temporary_key, temporary_certificate = temporary / "key.pem", temporary / "certificate.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-nodes", "-days", "3650", "-subj", "/CN=Robot Studio",
            "-addext", "subjectAltName=" + ",".join(subject_alt_names),
            "-keyout", str(temporary_key), "-out", str(temporary_certificate),
        ], check=True, capture_output=True)
        temporary_key.chmod(0o600)
        os.replace(temporary_key, key)
        os.replace(temporary_certificate, certificate)
    return certificate, key


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with self.server.context.wrap_socket(self.request, server_side=True) as client:
                with socket.create_connection(("127.0.0.1", self.server.target_port)) as upstream:
                    while True:
                        pending = client.pending() > 0
                        readable, _, _ = select.select([client, upstream], [], [], 0 if pending else None)
                        if pending and client not in readable:
                            readable.append(client)
                        for source in readable:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is client else client).sendall(data)
        except (OSError, ssl.SSLError) as error:
            logging.debug("HTTPS connection ended: %s", error)


class _ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, target_port, context):
        self.target_port = target_port
        self.context = context
        super().__init__(address, _ProxyHandler)


class SecureTransport:
    def __init__(self, listen, studio_port, directory=None,
                 secure_ports=(SECURE_STUDIO_PORT, SECURE_CONTROL_PORT, SECURE_MEDIA_PORT),
                 target_ports=None):
        directory = directory or Path.home() / ".config" / "robot-studio" / "tls"
        certificate, key = _certificate(directory)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(certificate), str(key))
        targets = target_ports or (studio_port, 8081, 8443)
        self.servers = []
        self.threads = []
        try:
            for secure_port, target_port in zip(secure_ports, targets):
                self.servers.append(_ProxyServer((listen, secure_port), target_port, context))
        except OSError:
            for server in self.servers:
                server.server_close()
            raise

    def start(self):
        for server in self.servers:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
            thread.start()
            self.threads.append(thread)
        logging.info("HTTPS Studio 入口：端口 %s", self.servers[0].server_address[1])

    def close(self):
        for server in self.servers[:len(self.threads)]:
            server.shutdown()
        for server in self.servers:
            server.server_close()
        for thread in self.threads:
            thread.join()
