import argparse
import ctypes
from ctypes import wintypes
import json
import os
import socket
import sys
import threading
import time
import traceback

if os.name != "nt":
    import fcntl

IDLE_POLL_S = 5.0


if os.name == "nt":
    _PIPE_ACCESS_DUPLEX = 0x00000003
    _PIPE_TYPE_BYTE = 0x00000000
    _PIPE_READMODE_BYTE = 0x00000000
    _PIPE_WAIT = 0x00000000
    _PIPE_UNLIMITED_INSTANCES = 255
    _ERROR_PIPE_CONNECTED = 535
    _ERROR_BROKEN_PIPE = 109
    _ERROR_NO_DATA = 232
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _WindowsPipeConnection:
    _BUFFER_SIZE = 64 * 1024

    def __init__(self, name):
        if os.name != "nt":
            raise RuntimeError("Windows named pipes are unavailable on this platform")
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure_api()
        self._handle = self._kernel32.CreateNamedPipeW(
            name,
            _PIPE_ACCESS_DUPLEX,
            _PIPE_TYPE_BYTE | _PIPE_READMODE_BYTE | _PIPE_WAIT,
            _PIPE_UNLIMITED_INSTANCES,
            self._BUFFER_SIZE,
            self._BUFFER_SIZE,
            0,
            None,
        )
        if self._handle in (None, _INVALID_HANDLE_VALUE):
            raise ctypes.WinError(ctypes.get_last_error())
        self._write_lock = threading.Lock()
        self._buffer = bytearray()
        self._closed = False

    def _configure_api(self):
        self._kernel32.CreateNamedPipeW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
        ]
        self._kernel32.CreateNamedPipeW.restype = wintypes.HANDLE
        self._kernel32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        self._kernel32.ConnectNamedPipe.restype = wintypes.BOOL
        self._kernel32.ReadFile.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPVOID,
        ]
        self._kernel32.ReadFile.restype = wintypes.BOOL
        self._kernel32.WriteFile.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPVOID,
        ]
        self._kernel32.WriteFile.restype = wintypes.BOOL
        self._kernel32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
        self._kernel32.DisconnectNamedPipe.restype = wintypes.BOOL
        self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self._kernel32.CloseHandle.restype = wintypes.BOOL

    def connect(self):
        if self._kernel32.ConnectNamedPipe(self._handle, None):
            return
        error = ctypes.get_last_error()
        if error != _ERROR_PIPE_CONNECTED:
            raise ctypes.WinError(error)

    def _read_chunk(self):
        if self._closed:
            return b""
        buffer = ctypes.create_string_buffer(self._BUFFER_SIZE)
        count = wintypes.DWORD()
        if not self._kernel32.ReadFile(self._handle, buffer, self._BUFFER_SIZE, ctypes.byref(count), None):
            error = ctypes.get_last_error()
            if error in (_ERROR_BROKEN_PIPE, _ERROR_NO_DATA):
                return b""
            raise ctypes.WinError(error)
        return buffer.raw[: count.value]

    def readline(self):
        while True:
            newline = self._buffer.find(bytes([10]))
            if newline >= 0:
                line = bytes(self._buffer[: newline + 1])
                del self._buffer[: newline + 1]
                return line
            chunk = self._read_chunk()
            if not chunk:
                if not self._buffer:
                    return b""
                line = bytes(self._buffer)
                self._buffer.clear()
                return line
            self._buffer.extend(chunk)

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def sendall(self, data):
        with self._write_lock:
            if self._closed:
                raise BrokenPipeError("named pipe is closed")
            offset = 0
            while offset < len(data):
                chunk = ctypes.create_string_buffer(data[offset:])
                count = wintypes.DWORD()
                if not self._kernel32.WriteFile(
                    self._handle,
                    chunk,
                    len(data) - offset,
                    ctypes.byref(count),
                    None,
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
                if count.value == 0:
                    raise BrokenPipeError("named pipe write made no progress")
                offset += count.value

    def close(self):
        with self._write_lock:
            if self._closed:
                return
            self._closed = True
            handle = self._handle
            self._handle = None
            self._kernel32.DisconnectNamedPipe(handle)
            self._kernel32.CloseHandle(handle)

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.close()


def log(message):
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if hasattr(value, "model_dump"):
        return json_safe(value.model_dump())
    if hasattr(value, "item"):
        return json_safe(value.item())
    raise TypeError(f"Laya returned a non-JSON value: {type(value).__name__}")


class LayaModel:
    def __init__(self, repo, subfolder, cache_dir):
        self.repo = repo
        self.subfolder = subfolder
        self.cache_dir = cache_dir
        self.agent = None
        self.device = None

    def ensure(self):
        if self.agent is not None:
            return self.agent
        os.makedirs(self.cache_dir, exist_ok=True)
        os.environ["HF_HOME"] = self.cache_dir
        os.environ["HF_HUB_CACHE"] = os.path.join(self.cache_dir, "hub")
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["USE_TF"] = "0"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import laya

        started = time.monotonic()
        self.agent = laya.load(self.repo, subfolder=self.subfolder, device="cpu")
        reported = getattr(self.agent, "device", None)
        self.device = str(reported or "cpu").lower()
        if self.device != "cpu":
            self.agent = None
            raise RuntimeError(f"Laya loaded on {self.device!r}; CPU is required")
        log(f"loaded {self.repo}/{self.subfolder} on cpu in {time.monotonic() - started:.1f}s")
        return self.agent

    def judge(self, state, questions):
        agent = self.ensure()
        return json_safe(agent.predict(state, questions))


class Server:
    """Owns one endpoint; requests from every connection are serialized."""

    def __init__(self, model, tag, idle_seconds):
        self.model = model
        self.tag = tag
        self.idle_seconds = idle_seconds
        self.lock = threading.Lock()
        self.activity_lock = threading.Lock()
        self.last_activity = time.monotonic()
        self.in_flight = 0
        self.socket_path = None
        self._pipes = set()
        self._pipes_lock = threading.Lock()

    def _touch(self, delta):
        with self.activity_lock:
            self.in_flight += delta
            self.last_activity = time.monotonic()

    def _register_pipe(self, pipe):
        with self._pipes_lock:
            self._pipes.add(pipe)

    def _unregister_pipe(self, pipe):
        with self._pipes_lock:
            self._pipes.discard(pipe)

    def _close_pipes(self):
        with self._pipes_lock:
            pipes = list(self._pipes)
            self._pipes.clear()
        for pipe in pipes:
            pipe.close()

    def _exit(self, reason):
        log(f"{reason}; exiting")
        self._close_pipes()
        if os.name != "nt":
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass
        os._exit(0)

    def _idle_watchdog(self):
        while True:
            time.sleep(IDLE_POLL_S)
            with self.activity_lock:
                idle = self.in_flight == 0 and time.monotonic() - self.last_activity >= self.idle_seconds
            if idle:
                self._exit(f"idle for {self.idle_seconds:.0f}s")

    def handle(self, emit, request):
        kind = request.get("type")
        request_id = request.get("id")
        if kind == "ping":
            emit({"type": "pong", "id": request_id, "tag": self.tag})
            return
        if kind == "shutdown":
            self._exit("shutdown requested")
        if kind not in ("load", "judge"):
            raise ValueError(f"unknown request type: {kind!r}")
        self._touch(+1)
        try:
            with self.lock:
                if kind == "load":
                    self.model.ensure()
                    result = {"type": "loaded", "id": request_id, "device": self.model.device}
                else:
                    result = {
                        "type": "judgment",
                        "id": request_id,
                        "result": self.model.judge(request["state"], request["questions"]),
                    }
        finally:
            self._touch(-1)
        emit(result)

    def serve_connection(self, conn):
        write_lock = threading.Lock()

        def emit(obj):
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
            with write_lock:
                conn.sendall(data)

        def process(reader):
            for raw in reader:
                line = raw.strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                except Exception:
                    emit({"type": "error", "id": None, "error": traceback.format_exc()})
                    continue
                try:
                    self.handle(emit, request)
                except Exception:
                    emit({"type": "error", "id": request.get("id"), "error": traceback.format_exc()})

        try:
            if isinstance(conn, _WindowsPipeConnection):
                process(conn)
            else:
                with conn, conn.makefile("rb") as reader:
                    process(reader)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            if isinstance(conn, _WindowsPipeConnection):
                self._unregister_pipe(conn)
                conn.close()

    def _bind(self, socket_path):
        lock_fd = os.open(f"{socket_path}.bind.lock", os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            if os.path.exists(socket_path):
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    probe.connect(socket_path)
                    probe.close()
                    raise RuntimeError(f"Laya worker already listening on {socket_path}")
                except (ConnectionRefusedError, FileNotFoundError):
                    os.unlink(socket_path)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(socket_path)
            os.chmod(socket_path, 0o600)
            server.listen(16)
            return server
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    def _serve_posix(self, socket_path):
        os.makedirs(os.path.dirname(socket_path), exist_ok=True)
        server = self._bind(socket_path)
        threading.Thread(target=self._idle_watchdog, daemon=True).start()
        sys.stdout.write(f"omp laya worker listening on {socket_path}\n")
        sys.stdout.flush()
        while True:
            conn, _ = server.accept()
            threading.Thread(target=self.serve_connection, args=(conn,), daemon=True).start()

    def _serve_windows(self, socket_path):
        threading.Thread(target=self._idle_watchdog, daemon=True).start()
        sys.stdout.write(f"omp laya worker listening on {socket_path}\n")
        sys.stdout.flush()
        while True:
            conn = _WindowsPipeConnection(socket_path)
            self._register_pipe(conn)
            try:
                conn.connect()
            except Exception:
                self._unregister_pipe(conn)
                conn.close()
                raise
            threading.Thread(target=self.serve_connection, args=(conn,), daemon=True).start()

    def serve(self, socket_path):
        self.socket_path = socket_path
        if os.name == "nt":
            self._serve_windows(socket_path)
        else:
            self._serve_posix(socket_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--subfolder", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--idle-seconds", type=float, required=True)
    args = parser.parse_args()
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["USE_TF"] = "0"
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    Server(
        LayaModel(args.repo, args.subfolder, args.cache_dir),
        args.tag,
        args.idle_seconds,
    ).serve(args.socket)


if __name__ == "__main__":
    main()
