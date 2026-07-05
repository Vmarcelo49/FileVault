#!/usr/bin/env python3
"""
daemon.py — Spawn a long-running command detached from the bash session.

Uses double-fork pattern to escape the session cgroup, so the process
survives between ephemeral bash tool calls.

Adapted version (v2) — changes from upstream:
  * STATE_DIR defaults to ~/.filevault/daemons (persistent across sessions;
    override with FILEVAULT_DAEMONS_DIR or --state-dir).
  * New `--cwd <dir>` and `--env KEY=VAL ...` flags on `start`.
  * New `start-filevault` convenience command that knows where the
    FileVault project lives and starts `npm start` with the right cwd.
  * `status` now also prints RSS memory and parent PID.
  * `restart <name>` shorthand.
  * `--json` flag on `list` and `status` for machine-readable output.

Usage:
    python3 daemon.py start <name> <command...> [--cwd DIR] [--env K=V ...]
    python3 daemon.py start-filevault [local]
    python3 daemon.py stop <name>
    python3 daemon.py status <name> [--json]
    python3 daemon.py list [--json]
    python3 daemon.py restart <name>
    python3 daemon.py logs <name> [lines]
    python3 daemon.py kill-all
"""
import os
import sys
import time
import json
import shlex
import signal
import subprocess
from pathlib import Path

# Resolve state dir with sensible precedence:
#   1. FILEVAULT_DAEMONS_DIR env var
#   2. ~/.filevault/daemons
# This keeps daemon state out of /tmp (which may be wiped) and survives
# across shell sessions, while remaining portable across machines.
_state_env = os.environ.get('FILEVAULT_DAEMONS_DIR')
if _state_env:
    STATE_DIR = Path(_state_env).expanduser()
else:
    STATE_DIR = Path.home() / '.filevault' / 'daemons'
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Known project location for the convenience command.
# Defaults to the directory containing this script so the daemon works
# whether invoked from inside the repo or from elsewhere.
FILEVAULT_DIR = Path(os.environ.get('FILEVAULT_DIR') or Path(__file__).resolve().parent)


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def read_proc_field(pid, field):
    """Read a field from /proc/<pid>/status. Returns '' on failure."""
    try:
        with open(f'/proc/{pid}/status') as f:
            for line in f:
                if line.startswith(field + ':'):
                    return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return ''


def spawn_daemon(name, cmd_args, cwd=None, env_extra=None):
    """Double-fork to detach from session, then exec the command."""
    pid_file = STATE_DIR / f"{name}.pid"
    log_file = STATE_DIR / f"{name}.log"
    cmd_file = STATE_DIR / f"{name}.cmd"
    meta_file = STATE_DIR / f"{name}.meta"

    if pid_file.exists():
        old_pid = pid_file.read_text().strip()
        if old_pid and process_alive(int(old_pid)):
            print(f"❌ Daemon '{name}' already running (PID {old_pid})")
            sys.exit(1)

    # FIX: store the command shlex-quoted so restart can shlex.split it
    # back safely even when arguments contain spaces.
    cmd_file.write_text(' '.join(shlex.quote(a) for a in cmd_args))
    meta = {'cwd': cwd or None, 'env_extra': env_extra or {}}
    meta_file.write_text(json.dumps(meta))

    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent: wait briefly for daemon to write PID file
        for _ in range(20):
            if pid_file.exists():
                break
            time.sleep(0.1)
        try:
            actual_pid = pid_file.read_text().strip()
            print(f"✅ Started '{name}' (PID {actual_pid})")
            print(f"   Log: {log_file}")
            print(f"   Cmd: {' '.join(cmd_args)}")
            if cwd:
                print(f"   Cwd: {cwd}")
        except Exception:
            print(f"✅ Started '{name}' (parent fork PID {pid})")
        return

    # Child: become session leader
    os.setsid()
    os.umask(0)

    # Second fork (true daemon)
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Now we're the daemon — write PID
    actual_pid = os.getpid()
    pid_file.write_text(str(actual_pid))

    # Build env: inherit current + apply extras
    proc_env = os.environ.copy()
    if env_extra:
        for k, v in env_extra.items():
            proc_env[k] = v

    # Open log
    log_fd = open(log_file, 'a', buffering=1)
    log_fd.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] === Starting '{name}' (PID {actual_pid}) ===\n")
    log_fd.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] cwd={cwd or '.'} env_extra={env_extra or {}}\n")
    log_fd.flush()

    try:
        proc = subprocess.Popen(
            cmd_args,
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=log_fd,
            cwd=cwd,
            env=proc_env,
        )
        # Update PID file with the actual subprocess PID
        pid_file.write_text(str(proc.pid))
        proc.wait()
        log_fd.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Process exited with code {proc.returncode}\n")
    except Exception as e:
        log_fd.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Spawn error: {e}\n")
    finally:
        try:
            pid_file.unlink()
        except Exception:
            pass


def stop_daemon(name):
    pid_file = STATE_DIR / f"{name}.pid"
    if not pid_file.exists():
        print(f"❌ Daemon '{name}' not running (no PID file)")
        return False
    pid = int(pid_file.read_text().strip())
    if not process_alive(pid):
        pid_file.unlink(missing_ok=True)
        print(f"❌ Daemon '{name}' was not running (stale PID file removed)")
        return False
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"⏹ Sent SIGTERM to '{name}' (PID {pid})")
        for _ in range(20):
            if not process_alive(pid):
                break
            time.sleep(0.2)
        if process_alive(pid):
            os.kill(pid, signal.SIGKILL)
            print(f"🔪 Sent SIGKILL to '{name}' (PID {pid})")
        pid_file.unlink(missing_ok=True)
        print(f"✅ Stopped '{name}'")
        return True
    except Exception as e:
        print(f"❌ Error stopping: {e}")
        return False


def status_daemon(name, as_json=False):
    pid_file = STATE_DIR / f"{name}.pid"
    cmd_file = STATE_DIR / f"{name}.cmd"
    meta_file = STATE_DIR / f"{name}.meta"
    if not pid_file.exists():
        if as_json:
            print(json.dumps({'name': name, 'running': False}))
            return False
        print(f"🔴 '{name}' not running")
        return False
    pid = int(pid_file.read_text().strip())
    if not process_alive(pid):
        pid_file.unlink(missing_ok=True)
        if as_json:
            print(json.dumps({'name': name, 'running': False, 'stale': True}))
            return False
        print(f"🔴 '{name}' not running (stale PID file)")
        return False
    info = {'name': name, 'running': True, 'pid': pid}
    try:
        with open(f'/proc/{pid}/stat') as f:
            stat = f.read().split()
            start_ticks = int(stat[21])
            hz = os.sysconf(os.sysconf_names['SC_CLK_TCK'])
            boot_time = 0
            with open('/proc/stat') as f:
                for line in f:
                    if line.startswith('btime'):
                        boot_time = int(line.split()[1])
                        break
            start_time = boot_time + (start_ticks / hz)
            elapsed = time.time() - start_time
            elapsed_str = time.strftime('%H:%M:%S', time.gmtime(elapsed))
            info['uptime_sec'] = round(elapsed, 1)
            info['uptime'] = elapsed_str
    except Exception:
        elapsed_str = '?'
    info['rss'] = read_proc_field(pid, 'VmRSS')
    info['ppid'] = read_proc_field(pid, 'PPid')
    info['cmd'] = cmd_file.read_text() if cmd_file.exists() else '?'
    if meta_file.exists():
        try:
            info['meta'] = json.loads(meta_file.read_text())
        except Exception:
            info['meta'] = {}
    if as_json:
        print(json.dumps(info))
        return True
    print(f"🟢 '{name}' running")
    print(f"   PID: {pid}")
    print(f"   PPID: {info.get('ppid', '?')}")
    print(f"   Uptime: {elapsed_str}")
    print(f"   RSS: {info.get('rss', '?')}")
    print(f"   Cmd: {info['cmd']}")
    if info.get('meta', {}).get('cwd'):
        print(f"   Cwd: {info['meta']['cwd']}")
    return True


def list_daemons(as_json=False):
    pids = list(STATE_DIR.glob('*.pid'))
    if not pids:
        if as_json:
            print(json.dumps([]))
            return
        print("No daemons registered")
        return
    rows = []
    for pid_file in pids:
        name = pid_file.stem
        try:
            pid = int(pid_file.read_text().strip())
            alive = process_alive(pid)
            cmd_file = STATE_DIR / f"{name}.cmd"
            cmd = cmd_file.read_text()[:40] if cmd_file.exists() else ''
            rows.append({'name': name, 'pid': pid, 'alive': alive, 'cmd': cmd})
            if not alive:
                pid_file.unlink(missing_ok=True)
        except Exception as e:
            rows.append({'name': name, 'pid': None, 'alive': False, 'error': str(e)})
    if as_json:
        print(json.dumps(rows))
        return
    print(f"{'NAME':<20} {'PID':<8} {'STATUS':<10} {'CMD'}")
    print("-" * 80)
    for r in rows:
        status = '🟢 alive' if r['alive'] else '🔴 dead'
        print(f"{r['name']:<20} {str(r['pid'] or '?'):<8} {status:<10} {r['cmd']}")


def tail_logs(name, lines=30):
    log_file = STATE_DIR / f"{name}.log"
    if not log_file.exists():
        print(f"No log file for '{name}'")
        return
    content = log_file.read_text().splitlines()
    for line in content[-lines:]:
        print(line)


def restart_daemon(name):
    pid_file = STATE_DIR / f"{name}.pid"
    cmd_file = STATE_DIR / f"{name}.cmd"
    meta_file = STATE_DIR / f"{name}.meta"
    if not cmd_file.exists():
        print(f"❌ No previous command recorded for '{name}'")
        return False
    # FIX: use shlex.split so paths with spaces (e.g. --cwd /home/z/my dir)
    # survive the round-trip through the .cmd file. Previously a naive
    # .split(' ') broke on any argument containing a space.
    cmd_args = shlex.split(cmd_file.read_text())
    meta = {}
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            pass
    if process_alive_check(pid_file):
        stop_daemon(name)
        time.sleep(0.5)
    print(f"🔁 Restarting '{name}'...")
    spawn_daemon(name, cmd_args, cwd=meta.get('cwd'), env_extra=meta.get('env_extra'))


def process_alive_check(pid_file):
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text().strip())
        return process_alive(pid)
    except Exception:
        return False


def start_filevault(mode='tunnel'):
    """Convenience: start the FileVault project that lives at FILEVAULT_DIR."""
    if not FILEVAULT_DIR.exists():
        print(f"❌ FileVault project not found at {FILEVAULT_DIR}")
        sys.exit(1)
    if not (FILEVAULT_DIR / 'node_modules').exists():
        print(f"⚠ node_modules missing — running `npm install` first...")
        rc = subprocess.call(['npm', 'install'], cwd=str(FILEVAULT_DIR))
        if rc != 0:
            print(f"❌ npm install failed (rc={rc})")
            sys.exit(rc)
    if mode == 'local':
        cmd_args = ['npm', 'run', 'local']
        env_extra = {'LOCAL_ONLY': 'true'}
    else:
        cmd_args = ['npm', 'start']
        env_extra = {}
    # Read AUTH_TOKEN from the project's .env for display
    env_path = FILEVAULT_DIR / '.env'
    token_hint = ''
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith('AUTH_TOKEN='):
                token_hint = line.split('=', 1)[1].strip()
                break
    # FIX: don't print a partial AUTH_TOKEN — even the first 16 + last 8
    # chars (37% of a 64-char token) is enough to aid brute force.
    # Show only the last 4 chars so the operator can confirm they're
    # using the right token without leaking any of it.
    if token_hint:
        masked = '****' + token_hint[-4:] if len(token_hint) > 4 else '****'
    else:
        masked = '(not set)'
    print(f"🔑 FileVault AUTH_TOKEN: {masked}")
    print(f"📁 Project: {FILEVAULT_DIR}")
    print(f"🌐 Mode: {'local-only' if mode == 'local' else 'public tunnel'}")
    spawn_daemon('filevault', cmd_args, cwd=str(FILEVAULT_DIR), env_extra=env_extra)


def parse_start_args(argv):
    """Parse: <name> <command...> [--cwd DIR] [--env K=V ...]"""
    if len(argv) < 2:
        print("Usage: daemon.py start <name> <command...> [--cwd DIR] [--env K=V ...]")
        sys.exit(1)
    name = argv[0]
    rest = argv[1:]
    cmd_args = []
    cwd = None
    env_extra = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == '--cwd':
            cwd = rest[i + 1]
            i += 2
        elif a == '--env':
            kv = rest[i + 1]
            if '=' not in kv:
                print(f"❌ --env expects KEY=VAL, got: {kv}")
                sys.exit(1)
            k, v = kv.split('=', 1)
            env_extra[k] = v
            i += 2
        elif a == '--':
            cmd_args.extend(rest[i + 1:])
            break
        else:
            cmd_args.append(a)
            i += 1
    if not cmd_args:
        print("❌ No command specified")
        sys.exit(1)
    return name, cmd_args, cwd, env_extra


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'start':
        name, cmd_args, cwd, env_extra = parse_start_args(sys.argv[2:])
        spawn_daemon(name, cmd_args, cwd=cwd, env_extra=env_extra)
    elif cmd == 'start-filevault':
        mode = sys.argv[2] if len(sys.argv) > 2 else 'tunnel'
        if mode not in ('tunnel', 'local'):
            print(f"❌ Unknown mode: {mode}. Use 'tunnel' or 'local'.")
            sys.exit(1)
        start_filevault(mode)
    elif cmd == 'stop':
        if len(sys.argv) < 3:
            print("Usage: daemon.py stop <name>")
            sys.exit(1)
        stop_daemon(sys.argv[2])
    elif cmd == 'status':
        if len(sys.argv) < 3:
            print("Usage: daemon.py status <name> [--json]")
            sys.exit(1)
        as_json = '--json' in sys.argv
        status_daemon(sys.argv[2], as_json=as_json)
    elif cmd == 'list':
        as_json = '--json' in sys.argv
        list_daemons(as_json=as_json)
    elif cmd == 'logs':
        if len(sys.argv) < 3:
            print("Usage: daemon.py logs <name> [lines]")
            sys.exit(1)
        lines = int(sys.argv[3]) if len(sys.argv) > 3 else 30
        tail_logs(sys.argv[2], lines)
    elif cmd == 'restart':
        if len(sys.argv) < 3:
            print("Usage: daemon.py restart <name>")
            sys.exit(1)
        restart_daemon(sys.argv[2])
    elif cmd == 'kill-all':
        pids = list(STATE_DIR.glob('*.pid'))
        for pid_file in pids:
            stop_daemon(pid_file.stem)
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
