import sys
import time
from datetime import datetime, timedelta


def _seconds_until_next_hour_plus_buffer(buffer_seconds: int = 5) -> int:
    """Seconds until the next HH:00 plus a small buffer (default 5s)."""
    now = datetime.now()
    next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    target = next_hour + timedelta(seconds=buffer_seconds)
    delta = target - now
    seconds = int(delta.total_seconds())
    return max(seconds, 1)


def _fmt_mmss(seconds: int) -> str:
    m, s = divmod(max(0, int(seconds)), 60)
    return f"{m:02d}:{s:02d}"


def wait_seconds_with_countdown(seconds: int, context: str = "Waiting") -> None:
    """Wait a fixed number of seconds with a live mm:ss countdown."""
    seconds = max(0, int(seconds))
    if seconds <= 0:
        return
    end = datetime.now() + timedelta(seconds=seconds)
    # Send local server time (Eastern) - client will interpret as local time
    end_str = end.replace(microsecond=0).strftime("%H:%M:%S")
    print(f"{context} for {seconds}s...")
    remaining = seconds
    try:
        while remaining > 0:
            msg = f"Retrying in { _fmt_mmss(remaining) }"
            # Force immediate output to both stdout and stderr for subprocess compatibility
            print(msg, flush=True)
            sys.stdout.flush()
            sys.stderr.flush()
            time.sleep(1)
            remaining -= 1
    finally:
        print("Resuming...")
        sys.stdout.flush()
        sys.stderr.flush()


def wait_until_next_hour_with_countdown(context: str = "Rate limited (429)", buffer_seconds: int = 5) -> None:
    """Block until the next top-of-hour + buffer (default 5s), with countdown.

    Fitbit rate limits generally reset at HH:00. To be safe, we wait until the
    next top-of-hour plus a small buffer before retrying.
    """
    seconds = _seconds_until_next_hour_plus_buffer(buffer_seconds)
    target = datetime.now() + timedelta(seconds=seconds)
    # Send local server time (Eastern) - client will interpret as local time
    target_str = target.replace(microsecond=0).strftime("%H:%M:%S")
    print(f"{context}. Waiting until {target_str} (top of hour + {buffer_seconds}s)...")
    remaining = seconds
    try:
        while remaining > 0:
            msg = f"Retrying in { _fmt_mmss(remaining) }"
            # Use newlines for better subprocess compatibility
            print(msg, flush=True)
            sys.stdout.flush()
            sys.stderr.flush()
            time.sleep(1)
            remaining -= 1
    finally:
        print("Resuming...")
        sys.stdout.flush()
        sys.stderr.flush()
