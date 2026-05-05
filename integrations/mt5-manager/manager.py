"""
MT5 Manager
===========
Windows service entry point. Responsibilities:

  1. Launch all MT5 terminal instances (portable mode, one per account)
  2. Wait for terminals to authenticate with their broker servers
  3. Launch one FastAPI worker subprocess per account
  4. Monitor workers — auto-restart any that crash
  5. Serve a gateway API on port 8000 that:
       GET  /health                         — aggregated health for all accounts
       GET  /accounts                       — list all configured accounts
       GET  /accounts/{id}/...              — proxy to that account's worker
       POST /accounts/{id}/...              — proxy to that account's worker

Run as a Windows service via NSSM (see install_service.ps1).
Can also be run directly for development: python manager.py
"""

import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response

# ── Base paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

# ── Logging ───────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [manager] [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_DIR / "manager.log", encoding="utf-8"),
    ],
    force=True,
)
logger = logging.getLogger("mt5-manager")

# ── Config ────────────────────────────────────────────────────────────────────────
_config_path = BASE_DIR / "accounts.json"
with open(_config_path) as _f:
    CONFIG = json.load(_f)

ACCOUNTS: list[dict] = CONFIG["accounts"]
ACCOUNTS_MAP: dict[str, dict] = {a["id"]: a for a in ACCOUNTS}
GATEWAY_PORT: int = int(CONFIG.get("gateway_port", 8000))
AUTH_TOKEN: str = CONFIG.get("bridge_auth_token", "")
MT5_STARTUP_WAIT: int = int(CONFIG.get("worker_startup_delay_seconds", 45))
WORKER_RESTART_DELAY: int = int(CONFIG.get("worker_restart_delay_seconds", 10))

# ── Process registry ──────────────────────────────────────────────────────────────
_mt5_procs: dict[str, subprocess.Popen] = {}     # account_id -> MT5 terminal
_worker_procs: dict[str, subprocess.Popen] = {}  # account_id -> FastAPI worker
_shutdown = threading.Event()
_worker_lock = threading.Lock()


# ── MT5 terminal management ───────────────────────────────────────────────────────
def _start_mt5_terminal(account: dict) -> Optional[subprocess.Popen]:
    mt5_exe = Path(account["mt5_dir"]) / "terminal64.exe"
    if not mt5_exe.exists():
        logger.error("[%s] MT5 terminal not found at %s — skipping", account["id"], mt5_exe)
        return None

    try:
        logger.info("[%s] Launching MT5 terminal: %s", account["id"], mt5_exe)
        proc = subprocess.Popen(
            [str(mt5_exe), "/portable"],
            cwd=str(mt5_exe.parent),
            # MT5 is a GUI app; no stdin/stdout capture needed
        )
        logger.info("[%s] MT5 started (pid=%d)", account["id"], proc.pid)
        return proc
    except Exception as exc:
        logger.error("[%s] Failed to launch MT5: %s", account["id"], exc)
        return None


def start_all_mt5_terminals() -> None:
    logger.info("Launching %d MT5 terminal(s)...", len(ACCOUNTS))
    for account in ACCOUNTS:
        proc = _start_mt5_terminal(account)
        if proc:
            _mt5_procs[account["id"]] = proc
        time.sleep(2)  # stagger to avoid hammering disk/network on startup
    logger.info("%d/%d MT5 terminal(s) launched.", len(_mt5_procs), len(ACCOUNTS))


# ── Worker management ─────────────────────────────────────────────────────────────
def _start_worker(account: dict) -> Optional[subprocess.Popen]:
    worker_script = BASE_DIR / "worker.py"
    log_file = LOG_DIR / f"{account['id']}.log"

    try:
        with open(log_file, "ab") as lf:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(worker_script),
                    "--account-id", account["id"],
                    "--port", str(account["port"]),
                    "--accounts-file", str(_config_path),
                ],
                stdout=lf,
                stderr=lf,
                cwd=str(BASE_DIR),
            )
        logger.info("[%s] Worker started on port %d (pid=%d)", account["id"], account["port"], proc.pid)
        return proc
    except Exception as exc:
        logger.error("[%s] Failed to start worker: %s", account["id"], exc)
        return None


def start_all_workers() -> None:
    logger.info("Launching %d account worker(s)...", len(ACCOUNTS))
    with _worker_lock:
        for account in ACCOUNTS:
            proc = _start_worker(account)
            if proc:
                _worker_procs[account["id"]] = proc
            time.sleep(0.5)
    logger.info("%d/%d worker(s) launched.", len(_worker_procs), len(ACCOUNTS))


def _monitor_workers() -> None:
    """Background thread: detect crashed workers and restart them."""
    logger.info("Worker monitor started.")
    while not _shutdown.is_set():
        with _worker_lock:
            for account in ACCOUNTS:
                aid = account["id"]
                proc = _worker_procs.get(aid)
                if proc is not None and proc.poll() is not None:
                    logger.warning(
                        "[%s] Worker (pid=%d) exited with code %d — restarting in %ds",
                        aid, proc.pid, proc.returncode, WORKER_RESTART_DELAY,
                    )
                    _shutdown.wait(timeout=WORKER_RESTART_DELAY)
                    if not _shutdown.is_set():
                        new_proc = _start_worker(account)
                        if new_proc:
                            _worker_procs[aid] = new_proc

        _shutdown.wait(timeout=5)
    logger.info("Worker monitor stopped.")


# ── Graceful shutdown ─────────────────────────────────────────────────────────────
def shutdown_all() -> None:
    logger.info("Shutting down all processes...")
    _shutdown.set()

    for aid, proc in _worker_procs.items():
        if proc.poll() is None:
            logger.info("Terminating worker [%s] (pid=%d)", aid, proc.pid)
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    for aid, proc in _mt5_procs.items():
        if proc.poll() is None:
            logger.info("Terminating MT5 [%s] (pid=%d)", aid, proc.pid)
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    logger.info("All processes stopped.")


# ── Gateway FastAPI ───────────────────────────────────────────────────────────────
@asynccontextmanager
async def _lifespan(app: FastAPI):
    logger.info("Gateway API up on port %d", GATEWAY_PORT)
    yield
    shutdown_all()


gateway = FastAPI(
    title="MT5 Manager Gateway",
    description="Aggregates and proxies requests to per-account MT5 worker processes.",
    lifespan=_lifespan,
)


@gateway.get("/health")
async def gateway_health():
    """Aggregated health check across all accounts. No auth required."""
    results = {}
    async with httpx.AsyncClient(timeout=5.0) as client:
        for account in ACCOUNTS:
            aid = account["id"]
            port = account["port"]
            try:
                resp = await client.get(f"http://127.0.0.1:{port}/health")
                data = resp.json()
                data.setdefault("accountId", aid)
                data["port"] = port
                results[aid] = data
            except Exception as exc:
                results[aid] = {
                    "accountId": aid,
                    "port": port,
                    "connected": False,
                    "error": str(exc),
                }

    all_connected = all(v.get("connected", False) for v in results.values())
    return {
        "ok": all_connected,
        "accountCount": len(ACCOUNTS),
        "connectedCount": sum(1 for v in results.values() if v.get("connected")),
        "accounts": results,
    }


@gateway.get("/accounts")
async def list_accounts():
    """List all configured accounts with their connectivity status."""
    worker_statuses = {}
    async with httpx.AsyncClient(timeout=3.0) as client:
        for account in ACCOUNTS:
            aid = account["id"]
            try:
                resp = await client.get(f"http://127.0.0.1:{account['port']}/health")
                worker_statuses[aid] = resp.json().get("connected", False)
            except Exception:
                worker_statuses[aid] = False

    return [
        {
            "id": a["id"],
            "name": a.get("name", a["id"]),
            "login": a["login"],
            "server": a["server"],
            "port": a["port"],
            "connected": worker_statuses.get(a["id"], False),
        }
        for a in ACCOUNTS
    ]


@gateway.api_route(
    "/accounts/{account_id}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
async def proxy_to_worker(account_id: str, path: str, request: Request):
    """
    Proxy any request to the appropriate account worker.

    Examples:
      GET  /accounts/account_1/account
      GET  /accounts/account_1/positions
      POST /accounts/account_1/orders
      GET  /accounts/account_1/quote/XAUUSD
    """
    account = ACCOUNTS_MAP.get(account_id)
    if account is None:
        raise HTTPException(status_code=404, detail=f"Account '{account_id}' not found")

    target_url = f"http://127.0.0.1:{account['port']}/{path}"

    # Forward all headers except hop-by-hop ones
    forward_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding")
    }

    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=forward_headers,
                content=body,
                params=dict(request.query_params),
                follow_redirects=False,
            )

        # Strip hop-by-hop response headers before forwarding
        skip_headers = {"content-encoding", "transfer-encoding", "content-length", "connection"}
        response_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in skip_headers
        }

        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=response_headers,
            media_type=resp.headers.get("content-type"),
        )

    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail=f"Worker for account '{account_id}' is not reachable (port {account['port']}). "
                   f"Check that the worker process is running.",
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail=f"Worker for account '{account_id}' timed out.",
        )
    except Exception as exc:
        logger.error("Proxy error for [%s]: %s", account_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Entry point ───────────────────────────────────────────────────────────────────
def main() -> None:
    logger.info("=" * 60)
    logger.info("MT5 Manager starting up")
    logger.info("Accounts configured: %d", len(ACCOUNTS))
    logger.info("Gateway port: %d", GATEWAY_PORT)
    logger.info("MT5 startup wait: %ds", MT5_STARTUP_WAIT)
    logger.info("=" * 60)

    # Step 1 — launch all MT5 terminals
    start_all_mt5_terminals()

    # Step 2 — wait for broker authentication
    logger.info(
        "Waiting %ds for MT5 terminals to authenticate with broker servers...",
        MT5_STARTUP_WAIT,
    )
    for remaining in range(MT5_STARTUP_WAIT, 0, -5):
        logger.info("  ...%ds remaining", remaining)
        time.sleep(min(5, remaining))

    # Step 3 — start all workers
    start_all_workers()

    # Step 4 — start monitor thread
    monitor_thread = threading.Thread(target=_monitor_workers, daemon=True, name="worker-monitor")
    monitor_thread.start()

    # Step 5 — register OS signal handlers (SIGINT / SIGTERM from NSSM or Ctrl+C)
    def _on_signal(sig, _frame):
        logger.info("Received signal %s — initiating shutdown", sig)
        shutdown_all()
        sys.exit(0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    # Step 6 — run gateway (blocking)
    logger.info("Starting gateway API on 0.0.0.0:%d", GATEWAY_PORT)
    uvicorn.run(
        gateway,
        host="0.0.0.0",
        port=GATEWAY_PORT,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    main()
