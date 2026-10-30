"""Integration tests against real local HTTP and TLS origins (no internet)."""
import http.client
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


class Origin(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        if self.path in ('/chunked-response', '/broken-chunk'):
            self.connection.sendall(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n'
                                    b'Connection: close\r\n\r\n3;ext=value\r\nabc\r\n')
            if self.path == '/chunked-response':
                self.connection.sendall(b'4\r\n\x00def\r\n0\r\nX-Trailer: end\r\n\r\n')
            return
        if self.path == '/broken-length':
            self.connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc')
            return
        if self.path == '/bad-response':
            self.connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n')
            return
        if self.path == '/interim':
            self.connection.sendall(b'HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n')
        if self.path == '/slow':
            time.sleep(2)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path.startswith('/binary'):
            result = bytes(range(256)) * 1024
        else:
            result = (self.command + ' ' + self.path + ' ' +
                      self.headers.get('X-Test', '')).encode() + b'\n' + body
        self.send_response(307 if self.path == '/redirect' else 201)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(result)))
        self.send_header('X-Origin', 'yes')
        self.send_header('Set-Cookie', 'a=1')
        self.send_header('Set-Cookie', 'b=2')
        self.send_header('Connection', 'close, X-Remove')
        self.send_header('X-Remove', 'secret')
        if self.path == '/redirect':
            self.send_header('Location', '/other')
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(result)
            except (BrokenPipeError, ssl.SSLError):
                pass

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = handle_request


def request(port, method='GET', path='/x', body=None, host='http.test', headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    conn.request(method, path, body, {'Host': host, 'X-Test': 'value', **(headers or {})})
    response = conn.getresponse()
    result = response.status, response.getheaders(), response.read()
    conn.close()
    return result


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def certificate(directory, name):
    cert, key = directory / f'{name}.pem', directory / f'{name}.key'
    template = directory / 'cert.cfg'
    template.write_text('cn = localhost\ndns_name = localhost\nexpiration_days = 1\n'
                        'ca\ncert_signing_key\ntls_www_server\nsigning_key\nencryption_key\n')
    for command in (
        ['certtool', '--generate-privkey', '--key-type=ecdsa', '--curve=secp256r1',
         '--outfile', str(key)],
        ['certtool', '--generate-self-signed', '--load-privkey', str(key),
         '--template', str(template), '--outfile', str(cert)],
    ):
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


def main():
    with tempfile.TemporaryDirectory() as directory:
        cert, key = certificate(Path(directory), 'trusted')
        untrusted_cert, untrusted_key = certificate(Path(directory), 'untrusted')
        http_server = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        https = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        untrusted = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        https.socket = context.wrap_socket(https.socket, server_side=True)
        untrusted_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        untrusted_context.load_cert_chain(untrusted_cert, untrusted_key)
        untrusted.socket = untrusted_context.wrap_socket(untrusted.socket, server_side=True)
        for server in (http_server, https, untrusted):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        port = free_port()
        env = {**os.environ, 'PORT': str(port), 'ORIGIN_TIMEOUT_MS': '500',
               'REQUEST_TIMEOUT_MS': '500',
               'MAX_BODY_BYTES': '1024', 'CA_BUNDLE': str(cert),
               'ORIGINS': f'http.test=http://127.0.0.1:{http_server.server_port};'
                          f'tls.test=https://localhost:{https.server_port};'
                          f'bad.test=https://127.0.0.1:{https.server_port};'
                          f'untrusted.test=https://localhost:{untrusted.server_port};'
                          f'down.test=http://127.0.0.1:{free_port()}'}
        for invalid in ({'PORT': '0'}, {'ORIGIN_TIMEOUT_MS': '-1'},
                        {'ORIGINS': 'x=http://localhost/path'},
                        {'ORIGINS': 'x=http://localhost;x=http://localhost'},
                        {'CA_BUNDLE': str(Path(directory) / 'missing.pem')}):
            result = subprocess.run([str(ROOT / 'zonal-cache')], env={**env, **invalid},
                                    capture_output=True, timeout=3)
            assert result.returncode != 0, invalid
        with subprocess.Popen([str(ROOT / 'zonal-cache')], env=env,
                              stdout=subprocess.DEVNULL) as proxy:
            try:
                for _ in range(100):
                    if proxy.poll() is not None:
                        raise AssertionError('proxy exited during startup')
                    try:
                        request(port)
                        break
                    except OSError:
                        time.sleep(.02)
                else:
                    raise AssertionError('proxy did not start')
                for host in ('http.test', 'tls.test'):
                    for method in ('GET', 'HEAD', 'POST', 'PUT', 'DELETE'):
                        body = b'\x00\xffpayload' if method in ('POST', 'PUT', 'DELETE') else None
                        path = '/a%2Fb/../c?x=%2F&x=2&empty='
                        actual = request(port, method, path, body, host)
                        expected = request(http_server.server_port, method, path, body)
                        assert (actual[0], actual[2]) == (expected[0], expected[2]), (host, method)
                        for name in ('Content-Type', 'Content-Length', 'X-Origin', 'Set-Cookie'):
                            assert [v for k, v in actual[1] if k.lower() == name.lower()] == [
                                v for k, v in expected[1] if k.lower() == name.lower()], (method, name)
                        assert not any(k.lower() == 'x-remove' for k, _ in actual[1])
                for host in ('http.test', 'tls.test'):
                    assert request(port, path='/binary', host=host)[2] == bytes(range(256)) * 1024
                assert request(port, path='/redirect')[0] == 307
                assert request(port, path='/interim')[0] == 201
                assert request(port, path='/bad-response')[0] == 502
                for host in ('http.test', 'tls.test'):
                    assert request(port, path='/chunked-response', host=host)[2] == b'abc\x00def'
                    for path in ('/broken-chunk', '/broken-length'):
                        try:
                            request(port, path=path, host=host)
                        except http.client.IncompleteRead:
                            pass
                        else:
                            raise AssertionError(f'{path}: incomplete response accepted')
                assert request(port, host='unknown.test')[0] == 421
                assert request(port, host='bad.test')[0] == 502
                assert request(port, host='untrusted.test')[0] == 502
                assert request(port, host='down.test')[0] == 502
                assert request(port, path='/slow')[0] == 504
                assert request(port, 'POST', body=b'x' * 1025)[0] == 413
                assert request(port, 'POST', body=b'x' * 1024)[0] == 201
                assert request(port, host=f'HTTP.TEST:{port}')[0] == 201
                assert request(port, headers={'Expect': 'unsupported'})[0] == 417
                stripped = request(port, headers={'Connection': 'X-Test'})[2]
                assert stripped == b'GET /x \n'
                for target in ('http://evil.test/x', '/bad%zz'):
                    assert request(port, path=target)[0] == 400
                with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
                    sock.sendall(b'GET / HTTP/1.1\r\nHost: http.test\r\nContent-Length: nope\r\n\r\n')
                    assert b'400' in sock.recv(4096)
                invalid = (
                    b'Host: http.test\r\nHost: http.test\r\n',
                    b'Host: http.test\r\nContent-Length: 0\r\nContent-Length: 0\r\n',
                    b'Host: http.test\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n',
                    b'Host : http.test\r\n',
                    b'Host: http.test\r\n Folded: value\r\n',
                    b'Host: http.test\r\nContent-Length: 18446744073709551616\r\n',
                )
                for fields in invalid:
                    with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
                        sock.sendall(b'GET / HTTP/1.1\r\n' + fields + b'\r\n')
                        assert b'400' in sock.recv(4096), fields
                with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
                    sock.sendall(b'GET / HTTP/1.1\r\nHost:')
                    assert b'408' in sock.recv(4096)
                with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
                    sock.sendall(b'POST / HTTP/1.1\r\nHost: http.test\r\n'
                                 b'Content-Length: 3\r\nExpect: 100-continue\r\n\r\n')
                    assert b'100 Continue' in sock.recv(4096)
                    sock.sendall(b'abc')
                    response = http.client.HTTPResponse(sock)
                    response.begin()
                    assert response.status == 201 and response.read() == b'POST / \nabc'
                for chunk, expected in ((b'zz\r\n', b'400'), (b'401\r\n' + b'x' * 1025 + b'\r\n', b'413')):
                    with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
                        sock.sendall(b'POST / HTTP/1.1\r\nHost: http.test\r\n'
                                     b'Transfer-Encoding: chunked\r\n\r\n' + chunk)
                        assert expected in sock.recv(4096)
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                conn.request('POST', '/chunked', iter([b'abc', b'\x00def']),
                             {'Host': 'http.test', 'X-Test': 'value'}, encode_chunked=True)
                response = conn.getresponse()
                assert response.status == 201 and response.read() == b'POST /chunked value\nabc\x00def'
                conn.close()
                stalled = []
                try:
                    for _ in range(40):
                        sock = socket.create_connection(('127.0.0.1', port), timeout=3)
                        stalled.append(sock)
                        sock.sendall(b'GET / HTTP/1.1\r\nHost:')
                    for sock in stalled:
                        assert b'408' in sock.recv(4096)
                finally:
                    for sock in stalled:
                        sock.close()
                assert request(port)[0] == 201
                print('PASS: HTTP/HTTPS, methods, raw target, headers, binary, validation, timeout, TLS, chunked')
            finally:
                proxy.terminate()
                proxy.wait(timeout=5)
                http_server.shutdown()
                https.shutdown()
                untrusted.shutdown()


if __name__ == '__main__':
    main()
