#!/usr/bin/python3
"""Own a session until the command and its output pipes finish.

Only JSON results are written to our stdout. Command output has separate pipes.
SIGTERM cancels this owned process group, including normal pipeline children.
The helper establishes group ownership before launching user commands, so GJS can
cancel a live supervisor rather than signal a potentially recycled numeric PGID.
Python isolated mode and its standard library provide this POSIX process control;
no third-party packages, terminal, or interactive authentication are involved.
This is process cleanup, not a sandbox for the explicitly registered command.
"""
import json
import os
import selectors
import signal
import subprocess
import sys


def main():
    os.setsid()
    owned_group = os.getpid()

    def stop_group(*_):
        os.killpg(owned_group, signal.SIGKILL)

    signal.signal(signal.SIGTERM, stop_group)

    def fail(code):
        print(json.dumps({"error": code}), flush=True)
        stop_group()

    try:
        limit = int(sys.argv[1])
        if limit <= 0 or not sys.argv[2:]:
            raise ValueError("Invalid command supervisor arguments")
        child = subprocess.Popen(
            sys.argv[2:], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        output = bytearray()
        total = 0
        with selectors.DefaultSelector() as selector:
            for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map() or child.poll() is None:
                for key, _ in selector.select(timeout=0.05):
                    data = os.read(key.fd, 4096)
                    if not data:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    total += len(data)
                    if total > limit:
                        fail("output-limit")
                    if key.data == "stdout":
                        output.extend(data)
        if child.wait() != 0:
            fail("command-failed")
        text = output.decode("utf-8", errors="strict")
        if "\0" in text:
            fail("nul-output")
        print(json.dumps({"text": text}, ensure_ascii=False), flush=True)
    except UnicodeError:
        fail("invalid-utf8")
    except OSError:
        fail("launch-failed")
    except Exception:
        fail("supervisor-failed")


if __name__ == "__main__":
    main()
