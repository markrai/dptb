import os
import sys
import argparse
import subprocess
import re
from datetime import datetime


def run_script(script_path: str, cwd: str, extra_args=None) -> tuple[int, str | None]:
    print("=" * 60)
    print(f"Starting {os.path.basename(script_path)} at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    try:
        # Stream child output and capture a concise start line for summary
        cmd = [sys.executable, "-u", script_path]
        if extra_args:
            cmd.extend(extra_args)
        env = os.environ.copy()
        # Ensure child scripts can emit Unicode without crashing on Windows consoles
        env.setdefault("PYTHONIOENCODING", "utf-8")
        # Force unbuffered output for real-time streaming
        env.setdefault("PYTHONUNBUFFERED", "1")
        out_enc = sys.stdout.encoding or "utf-8"
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=0,  # Unbuffered for real-time output
            universal_newlines=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        start_line: str | None = None
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                # Forward the line to our stdout for server.py to capture
                # This ensures the terminal modal gets the individual script output
                print(line, end="", flush=True)
                # Capture the first "Starting ... fetch from ..." line for summary
                if start_line is None:
                    l = line.strip()
                    l_low = l.lower()
                    if "starting " in l_low and " fetch from " in l_low:
                        start_line = l
        except KeyboardInterrupt:
            proc.kill()
            raise
        code = proc.wait()
        if code == 0:
            print(f"OK: {os.path.basename(script_path)} completed successfully.\n")
        else:
            print(f"ERR: {os.path.basename(script_path)} exited with code {code}.\n")
        sys.stdout.flush()  # Ensure output is flushed to parent process
        return code, start_line
    except KeyboardInterrupt:
        print("Interrupted: Received KeyboardInterrupt; stopping.")
        return 130, None
    except Exception as e:
        print(f"ERR: Failed to run {script_path}: {e}")
        return 1, None


def discover_profiles(fetch_dir: str) -> list[str]:
    repo_root = os.path.dirname(fetch_dir)
    profiles_dir = os.path.join(repo_root, "profiles")
    ids: list[str] = []
    if os.path.isdir(profiles_dir):
        for entry in os.listdir(profiles_dir):
            p = os.path.join(profiles_dir, entry)
            if os.path.isdir(p) and os.path.exists(os.path.join(p, "auth", "tokens.json")):
                ids.append(entry)
    ids.sort()
    return ids


def main():
    this_dir = os.path.dirname(os.path.abspath(__file__))

    parser = argparse.ArgumentParser(description="Run Fitbit fetch scripts for one or more profiles.")
    parser.add_argument(
        "--stop-on-error",
        action="store_true",
        help="Stop immediately if any script fails (non-zero exit).",
    )
    parser.add_argument(
        "--use-alt-sleep",
        action="store_true",
        help="Use the alternate sleep fetch script instead of the default.",
    )
    parser.add_argument(
        "--profile",
        help="Profile id to read/write tokens and CSVs (single run)",
        default=None,
    )
    parser.add_argument(
        "--profiles",
        nargs="+",
        help="Run for a list of profile ids",
        default=None,
    )
    parser.add_argument(
        "--all-profiles",
        action="store_true",
        help="Run for all discovered profiles under ../profiles/",
    )
    args = parser.parse_args()

    # Order matters a bit only for user feedback; they are independent API calls
    sleep_script = (
        "fetch_sleep_data_alternate_version.py" if args.use_alt_sleep else "fetch_sleep_data.py"
    )
    scripts = [
        "fetch_steps.py",
        "fetch_rhr_data.py",
        "fetch_hrv_data.py",
        sleep_script,
    ]

    discovered = discover_profiles(this_dir)

    # Determine which profiles to run
    if args.profile:
        selected_profiles = [args.profile]
    elif args.profiles:
        # de-duplicate while preserving order
        seen = set()
        selected_profiles = []
        for pid in args.profiles:
            if pid not in seen:
                seen.add(pid)
                selected_profiles.append(pid)
    elif args.all_profiles or discovered:
        # By default, if profiles exist, run them all
        selected_profiles = discovered
    else:
        # Legacy default (no profiles configured)
        selected_profiles = [None]

    # (profile, script_name, exit_code, start_line)
    overall_results: list[tuple[str | None, str, int, str | None]] = []
    any_fail = False

    # Quick visibility into which profiles will run
    if selected_profiles and selected_profiles != [None]:
        print("Profiles to run: " + ", ".join((p or "default") for p in selected_profiles))
    else:
        print("Profiles to run: default")

    for prof in selected_profiles:
        print("\n" + "=" * 60)
        print(f"Running fetches for profile: {prof or 'default'}")
        print("=" * 60)
        for i, name in enumerate(scripts, 1):
            print(f"\n[{i}/{len(scripts)}] Starting {name}...")
            path = os.path.join(this_dir, name)
            if not os.path.exists(path):
                print(f"WARN: Script not found, skipping: {name}")
                overall_results.append((prof, name, 127))
                any_fail = True
                continue
            extra = ["--profile", prof] if prof else None
            code, start_line = run_script(path, cwd=this_dir, extra_args=extra)
            overall_results.append((prof, name, code, start_line))
            if code != 0 and args.stop_on_error:
                print("stop-on-error enabled; aborting remainder for this profile.")
                any_fail = True
                break
            print(f"SUCCESS: {name} completed")

    # Summary
    print("\n" + "=" * 60)
    print("Summary:\n")
    if selected_profiles and selected_profiles != [None]:
        # Group by profile
        by_prof: dict[str, list[tuple[str, int, str | None]]] = {}
        for prof, name, code, start_line in overall_results:
            key = (prof or "default")
            by_prof.setdefault(key, []).append((name, code, start_line))
            if code != 0:
                any_fail = True
        first = True
        for prof, rows in by_prof.items():
            if not first:
                print("")  # separate profiles with a blank line for readability
            first = False
            print(f"Profile: {prof}")
            for name, code, start_line in rows:
                status = "OK" if code == 0 else f"FAIL ({code})"
                if start_line:
                    print(f" - {name}: {status} | {start_line}")
                else:
                    print(f" - {name}: {status}")
    else:
        for _prof, name, code, start_line in overall_results:
            status = "OK" if code == 0 else f"FAIL ({code})"
            if code != 0:
                any_fail = True
            if start_line:
                print(f" - {name}: {status} | {start_line}")
            else:
                print(f" - {name}: {status}")
    print("=" * 60)
    sys.stdout.flush()  # Ensure final output is flushed
    sys.exit(1 if any_fail else 0)


if __name__ == "__main__":
    main()
