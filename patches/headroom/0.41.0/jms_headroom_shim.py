"""Jev Memory Suite shim for Headroom 0.41.0 (Codex ChatGPT-login routing).

Run it with Headroom's own interpreter, never with a system Python:

    python -I jms_headroom_shim.py --check
    python -I jms_headroom_shim.py proxy --host 127.0.0.1 --port 18880 ...

Headroom 0.41.0 hardcodes chatgpt.com as the upstream for Codex ChatGPT-login
traffic, which bypasses the Jev codex gateway. This shim points those URLs at
the gateway by assigning module attributes only (no file under site-packages is
edited), refuses every non-loopback connection for the whole process, and checks
the result before it hands control to Headroom's CLI.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import ipaddress
import json
import os
import socket
import sys
from typing import Callable, NoReturn
from urllib.parse import urlsplit

SUPPORTED_VERSION = "0.41.0"
BASE_ENV = "HEADROOM_CHATGPT_CODEX_BASE_URL"
# Modules whose module-level strings may name chatgpt.com. The usage poller only runs when HEADROOM_OFFLINE is unset,
# and the suite always sets it.
ALLOWED_STRING_MODULES = ("headroom.subscription.codex_rate_limits",)
_AF_UNIX = getattr(socket, "AF_UNIX", -1)

# Header names Headroom's wire-debug redaction must hide in addition to its own list. The ChatGPT account id is not a bearer
# token, so Headroom's request log would otherwise carry it in clear text.
REDACTED_HEADERS = ("chatgpt-account-id",)

_quiet = False       # True while the guard probes itself, so the probes do not write to stderr
_check_mode = False  # True for --check, which also reports failures as JSON on stdout


def fail(code: int, reason: str) -> NoReturn:
    print(f"jms-headroom-shim: {reason}", file=sys.stderr)
    if _check_mode:
        print(json.dumps({"ok": False, "reason": reason}, separators=(",", ":")))
    sys.exit(code)


def parse_base(raw: str | None) -> str:
    """Return the gateway origin for exactly http://127.0.0.1:<port>/v1, or exit 2."""
    if not raw:
        fail(2, f"{BASE_ENV} is required, for example http://127.0.0.1:18878/v1")
    parts = urlsplit(raw)
    try:
        port = parts.port
    except ValueError:
        port = None
    # Comparing against the canonical form also rejects userinfo, query, fragment, trailing slashes and odd ports.
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or port is None or not 1024 <= port <= 65535
            or raw != f"http://127.0.0.1:{port}/v1"):
        fail(2, f"{BASE_ENV} must be exactly http://127.0.0.1:<port>/v1 with a port from 1024 to 65535")
    return f"http://127.0.0.1:{port}"


def check_version() -> str:
    try:
        installed = importlib.metadata.version("headroom-ai")
    except importlib.metadata.PackageNotFoundError:
        installed = "not installed"
    if installed != SUPPORTED_VERSION:
        fail(3, f"Headroom {installed} is installed; this shim supports only {SUPPORTED_VERSION}")
    return installed


# Only loopback is reachable from this process. Names are refused before any resolver runs, so no DNS query leaves the machine.
_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _text(host: object) -> str:
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    return "".join(ch if ch.isprintable() else "?" for ch in str(host))[:255]


def _loopback(name: str) -> bool:
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def _refuse(name: str) -> NoReturn:
    if not _quiet:
        print(f"jms-egress-blocked host={name}", file=sys.stderr)
    raise ConnectionRefusedError(f"egress blocked by jev-memory-suite: {name}")


def _check_address(family: int, address: object) -> None:
    if family == _AF_UNIX:
        return
    if family not in (socket.AF_INET, socket.AF_INET6) or not isinstance(address, tuple) or not address:
        _refuse(f"family-{int(family)}")
    name = _text(address[0])
    if not _loopback(name):
        _refuse(name)


def _guarded_getaddrinfo(host, port, *args, **kwargs):
    if host not in (None, "", b"") and not _loopback(_text(host)):
        _refuse(_text(host))
    return _real_getaddrinfo(host, port, *args, **kwargs)


def _guarded_connect(self: socket.socket, address: object) -> None:
    _check_address(self.family, address)
    return _real_connect(self, address)


def _guarded_connect_ex(self: socket.socket, address: object) -> int:
    _check_address(self.family, address)
    return _real_connect_ex(self, address)


def _guard_sock_connect(real: Callable):
    async def sock_connect(self, sock, address):
        _check_address(sock.family, address)
        return await real(self, sock, address)
    return sock_connect


def install_guard() -> None:
    import asyncio.proactor_events
    import asyncio.selector_events

    socket.getaddrinfo = _guarded_getaddrinfo
    socket.socket.connect = _guarded_connect
    socket.socket.connect_ex = _guarded_connect_ex
    for loop in (asyncio.selector_events.BaseSelectorEventLoop, asyncio.proactor_events.BaseProactorEventLoop):
        loop.sock_connect = _guard_sock_connect(loop.sock_connect)


def _outcome(call: Callable[[], object]) -> str:
    try:
        call()
        return "ok"
    except ConnectionRefusedError:
        return "refused"
    except OSError:
        return "error"


def verify_guard() -> dict[str, bool]:
    global _quiet
    _quiet = True
    try:
        blocked = (_outcome(lambda: socket.getaddrinfo("chatgpt.com", 443)) == "refused"
                   and _outcome(lambda: _check_address(socket.AF_INET, ("203.0.113.10", 443))) == "refused")
        allowed = _outcome(lambda: socket.getaddrinfo("127.0.0.1", 80)) == "ok"
    finally:
        _quiet = False
    return {"externalBlocked": blocked, "loopbackAllowed": allowed}


def apply_patch(origin: str) -> None:
    try:
        endpoints = importlib.import_module("headroom.providers.codex.endpoints")
        proxy_targets = importlib.import_module("headroom.providers.proxy_targets")
    except Exception as exc:  # any import-time failure means the code shape is not the one this shim was written for
        fail(4, f"Headroom modules did not import: {type(exc).__name__}")
    ws = origin.replace("http://", "ws://", 1)
    # (module, attribute, original value, new value). Every original is checked before anything is changed.
    targets = [
        (endpoints, "CHATGPT_BACKEND_API_URL", "https://chatgpt.com", origin),
        (endpoints, "CHATGPT_BACKEND_WS_URL", "wss://chatgpt.com", ws),
        (endpoints, "CODEX_BACKEND_PREFIX", "/backend-api/codex", "/v1"),
        (proxy_targets, "CHATGPT_BACKEND_API_URL", "https://chatgpt.com", origin),
    ]
    for module, attr, original, _ in targets:
        if getattr(module, attr, None) != original:
            fail(4, f"{module.__name__}.{attr} is not the expected Headroom {SUPPORTED_VERSION} value")
    policy, secret_keys = redaction_targets()
    for module, attr, _, new in targets:
        setattr(module, attr, new)
    policy.WIRE_DEBUG_SECRET_KEYS = (*secret_keys, *REDACTED_HEADERS)


def redaction_targets():
    """Return Headroom's wire-debug redaction module and its key tuple, or exit 4 when the code shape is not the expected one."""
    try:
        policy = importlib.import_module("headroom.proxy.wire_debug_redaction_policy")
    except Exception as exc:
        fail(4, f"Headroom wire-debug redaction did not import: {type(exc).__name__}")
    keys = getattr(policy, "WIRE_DEBUG_SECRET_KEYS", None)
    if not isinstance(keys, tuple) or any(header in keys for header in REDACTED_HEADERS):
        fail(4, "Headroom WIRE_DEBUG_SECRET_KEYS is not the expected tuple, or already redacts the shim headers")
    return policy, keys


def redaction_check() -> list[str]:
    """Prove the patched redaction hides the account id and keeps the bearer redaction, then report the headers it covers."""
    from headroom.proxy.wire_debug_redaction_policy import WIRE_DEBUG_REDACTED, redact_for_wire_debug

    probe = {header: "probe-value" for header in REDACTED_HEADERS}
    probe["authorization"] = "probe-value"
    redacted = redact_for_wire_debug(probe)
    if any(redacted.get(header) != WIRE_DEBUG_REDACTED for header in (*REDACTED_HEADERS, "authorization")):
        fail(5, "wire-debug redaction does not cover chatgpt-account-id")
    return list(REDACTED_HEADERS)


def string_hits() -> list[str]:
    hits = []
    for name, module in list(sys.modules.items()):
        if not name.startswith("headroom.") or module is None:
            continue
        for attr, value in vars(module).items():
            # Docstrings are documentation, not routing, so they are not counted.
            if attr != "__doc__" and isinstance(value, str) and "chatgpt.com" in value:
                hits.append(f"{name}:{attr}")
    return sorted(hits)


def self_test(origin: str) -> tuple[dict[str, str], list[str]]:
    from headroom.providers import proxy_targets
    from headroom.providers.codex import model_metadata, responses

    ws = origin.replace("http://", "ws://", 1)
    urls = {
        "responses": responses.codex_responses_http_url(),
        "responsesCompact": responses.codex_responses_subpath_url("compact"),
        "responsesWs": responses.codex_responses_websocket_url(),
        "models": model_metadata.codex_backend_url("models", "client_version=x"),
        "passthrough": proxy_targets.CHATGPT_BACKEND_API_URL,
    }
    expected = {
        "responses": f"{origin}/v1/responses",
        "responsesCompact": f"{origin}/v1/responses/compact",
        "responsesWs": f"{ws}/v1/responses",
        "models": f"{origin}/v1/models?client_version=x",
        "passthrough": origin,
    }
    for key, value in urls.items():
        if value != expected[key]:
            fail(5, f"Headroom URL {key} does not point at the gateway: {value}")
    hits = string_hits()
    unexpected = [hit for hit in hits if hit.split(":", 1)[0] not in ALLOWED_STRING_MODULES]
    if unexpected:
        fail(5, f"unexpected chatgpt.com constants in Headroom: {', '.join(unexpected)}")
    return urls, hits


def main() -> None:
    global _check_mode
    args = sys.argv[1:]
    _check_mode = args == ["--check"]
    if not _check_mode and args[:1] != ["proxy"]:
        fail(2, "usage: jms_headroom_shim.py --check | jms_headroom_shim.py proxy <headroom args>")
    version = check_version()
    raw = os.environ.get(BASE_ENV)
    origin = parse_base(raw)
    install_guard()
    apply_patch(origin)
    guard = verify_guard()
    if not all(guard.values()):
        fail(5, "egress guard did not refuse an external host or allow loopback")
    urls, hits = self_test(origin)
    redacted = redaction_check()
    if _check_mode:
        report = {"ok": True, "headroomVersion": version, "supported": SUPPORTED_VERSION, "base": raw,
                  "urls": urls, "allowedStringHits": hits, "guard": guard, "redactedHeaders": redacted}
        print(json.dumps(report, separators=(",", ":")))
        return
    sys.argv = ["headroom", *args]
    from headroom import cli

    cli.main()


if __name__ == "__main__":
    main()
