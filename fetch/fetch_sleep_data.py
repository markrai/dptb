import os
import json
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
import sys
import warnings
import subprocess
import argparse
import fcntl

# Suppress specific pandas FutureWarnings
warnings.filterwarnings('ignore', category=FutureWarning)
warnings.filterwarnings('ignore', message='.*DataFrame concatenation.*')

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from auth.refresh_token import refresh_token
from common.profile_paths import (
    get_active_profile,
    tokens_file_for,
    csv_path_for,
    ensure_dirs_for_csv,
)
from common.rate_limit import wait_until_next_hour_with_countdown, wait_seconds_with_countdown

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--profile", default=None)
args, _unknown = parser.parse_known_args()
PROFILE_ID = get_active_profile(args.profile)

TOKENS_FILE = tokens_file_for(PROFILE_ID)
CSV_FILE = csv_path_for(PROFILE_ID, "fitbit_sleep.csv")
os.environ["FITBIT_TOKENS_FILE"] = TOKENS_FILE
os.environ["FITBIT_PROFILE"] = PROFILE_ID or ""
ensure_dirs_for_csv(CSV_FILE)
CHUNK_DAYS = 100
FALLBACK_START_DATE = datetime.now() - timedelta(days=90)
RATE_LIMIT_DELAY = 2

COLUMNS = [
    "date","logId","isMainSleep","startTime","endTime","duration",
    "minutesAsleep","minutesAwake","minutesToFallAsleep","minutesAfterWakeup",
    "timeInBed","efficiency","infoCode",
    "minutesDeep","minutesREM",
    "sleepScore"
]

def get_access_token():
    with open(TOKENS_FILE) as f:
        return json.load(f)["access_token"]


def load_last_date():
    """Return the last saved date found in the CSV, or None if empty/missing."""
    if os.path.exists(CSV_FILE):
        try:
            df = pd.read_csv(CSV_FILE, usecols=["date"])  # only read date col for speed
            if df.empty or "date" not in df.columns:
                return None
            # Coerce to datetime and drop NaT
            dates = pd.to_datetime(df["date"], errors="coerce").dropna()
            if dates.empty:
                return None
            last_date = dates.max().date()
            return datetime(last_date.year, last_date.month, last_date.day)
        except Exception:
            return None
    return None


def reauthorize_and_get_token():
    """Run the interactive auth script to obtain fresh tokens and return access token."""
    auth_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "auth", "authorize_fitbit.py"))
    auth_dir = os.path.dirname(auth_script)
    try:
        print("Refresh token invalid. Launching authorization flow...")
        cmd = [sys.executable, auth_script]
        if PROFILE_ID:
            cmd.extend(["--profile", PROFILE_ID])
        result = subprocess.run(cmd, cwd=auth_dir, capture_output=False, check=True)
    except subprocess.CalledProcessError as e:
        print(f"Authorization script failed with exit code {e.returncode}")
        return None
    except Exception as e:
        print(f"Failed to launch authorization: {e}")
        return None
    try:
        return get_access_token()
    except Exception as e:
        print(f"Authorization completed but failed to read new token: {e}")
        return None


def daterange_chunks(start, end, delta_days):
    while start <= end:
        chunk_end = min(start + timedelta(days=delta_days - 1), end)
        yield start.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')
        start += timedelta(days=delta_days)


def fetch_sleep_chunk(start_str, end_str, token):
    url = f"https://api.fitbit.com/1.2/user/-/sleep/date/{start_str}/{end_str}.json"
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(3):
        try:
            res = requests.get(url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout: Fitbit API did not respond within 30 seconds for {start_str} to {end_str}")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error: {e}")
            continue
        print(f"Response {res.status_code} for {start_str} to {end_str}")
        # Honor Fitbit rate-limit headers even when the request succeeds
        maybe_throttle(res)
        if res.status_code == 200:
            return res.json(), token
        elif res.status_code == 429:
            # Prefer header-specified reset if available; fallback to top-of-hour wait
            try:
                reset_s = int(res.headers.get("fitbit-rate-limit-reset", "0"))
            except Exception:
                reset_s = 0
            if reset_s > 0:
                wait_for = max(reset_s + 1, 1)
                print("429 rate limit. Using header-provided reset.")
                wait_seconds_with_countdown(wait_for, context="Header reset")
            else:
                wait_until_next_hour_with_countdown("Rate limited by Fitbit (sleep)")
            continue
        elif res.status_code == 401:
            print("Access token expired. Refreshing...")
            try:
                token = refresh_token()
                headers = {"Authorization": f"Bearer {token}"}
            except PermissionError as e:
                print(f"Failed to refresh token: {e}")
                # Try running the refresh script first, then fallback to reauthorize
                try:
                    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "auth", "refresh_token.py"))
                    script_dir = os.path.dirname(script_path)
                    subprocess.run([sys.executable, script_path], cwd=script_dir, check=True)
                    try:
                        token = get_access_token()
                        headers = {"Authorization": f"Bearer {token}"}
                        print("Retrying request after running refresh_token.py...")
                        continue
                    except Exception as e2:
                        print(f"Failed to load access token after script: {e2}")
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                # Fallback to full reauthorization
                fresh = reauthorize_and_get_token()
                if fresh:
                    token = fresh
                    headers = {"Authorization": f"Bearer {token}"}
                    print("Retrying request with newly authorized token...")
                    continue
                return None, token
            except Exception as e:
                print(f"Failed to refresh token: {e}")
                # Fallback: run refresh_token.py script, then retry once
                try:
                    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "auth", "refresh_token.py"))
                    script_dir = os.path.dirname(script_path)
                    subprocess.run([sys.executable, script_path], cwd=script_dir, check=True)
                    try:
                        token = get_access_token()
                        headers = {"Authorization": f"Bearer {token}"}
                        print("Retrying request after running refresh_token.py...")
                        continue
                    except Exception as e2:
                        print(f"Failed to load access token after script: {e2}")
                        return None, token
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                    return None, token
        elif res.status_code == 404:
            print(f"WARNING: No sleep data available for {start_str} to {end_str} (404 - Data not found)")
            print("   This is normal if your watch wasn't synced or no sleep data was recorded.")
            # Return empty data instead of None to continue processing
            return {"sleep": []}, token
        elif res.status_code == 500:
            print(f"WARNING: Server error for {start_str} to {end_str} (500 - API error)")
            print("   This usually means the date range is too large. Will retry with smaller chunks.")
            # Return empty data to continue processing with smaller chunks
            return {"sleep": []}, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, token
    return None, token


def get_sleep_goal_minutes(token):
    url = "https://api.fitbit.com/1.2/user/-/sleep/goal.json"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        res = requests.get(url, headers=headers, timeout=30)
        # Apply header-based throttling hints from Fitbit
        maybe_throttle(res)
        if res.status_code == 200:
            data = res.json() or {}
            goal = data.get("goal", {})
            if isinstance(goal.get("minDuration"), (int, float)):
                return int(goal.get("minDuration"))
    except Exception:
        pass
    return 450


def parse_sleep(json_data):
    if not json_data or "sleep" not in json_data:
        return pd.DataFrame(columns=COLUMNS[:-1])
    rows = []
    for entry in json_data["sleep"]:
        levels = entry.get("levels") or {}
        summary = levels.get("summary") or {}
        deep = summary.get("deep", {}).get("minutes")
        rem = summary.get("rem", {}).get("minutes")
        row = {
            "date": entry.get("dateOfSleep"),
            "logId": entry.get("logId"),
            "isMainSleep": entry.get("isMainSleep"),
            "startTime": entry.get("startTime"),
            "endTime": entry.get("endTime"),
            "duration": entry.get("duration"),
            "minutesAsleep": entry.get("minutesAsleep"),
            "minutesAwake": entry.get("minutesAwake"),
            "minutesToFallAsleep": entry.get("minutesToFallAsleep"),
            "minutesAfterWakeup": entry.get("minutesAfterWakeup"),
            "timeInBed": entry.get("timeInBed"),
            "efficiency": entry.get("efficiency"),
            "infoCode": entry.get("infoCode"),
            "minutesDeep": deep,
            "minutesREM": rem,
        }
        rows.append(row)
    df = pd.DataFrame(rows)
    for c in COLUMNS:
        if c not in df.columns:
            df[c] = pd.NA
    df = df[COLUMNS[:-1]]
    return df


def maybe_throttle(res):
    """Inspect Fitbit rate-limit headers and sleep locally if needed.

    If 'fitbit-rate-limit-remaining' is <= 0 and 'fitbit-rate-limit-reset' is provided,
    sleep for reset seconds plus a small buffer. Safe no-op on missing headers.
    """
    try:
        remaining = int(res.headers.get("fitbit-rate-limit-remaining", "1"))
    except Exception:
        remaining = 1
    try:
        reset_s = int(res.headers.get("fitbit-rate-limit-reset", "0"))
    except Exception:
        reset_s = 0
    if remaining <= 0 and reset_s > 0:
        wait_for = max(reset_s + 1, 1)
        print(f"Rate-limit headers indicate reset in {reset_s}s.")
        wait_seconds_with_countdown(wait_for, context="Header reset")

def clamp(v, lo=0.0, hi=100.0):
    if v is None:
        return None
    return max(lo, min(hi, v))


def _safe_csv_write(csv_path, dataframe):
    """Write CSV file with file locking to prevent race conditions"""
    lock_path = csv_path + '.lock'
    try:
        with open(lock_path, 'w') as lockfile:
            fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX)
            dataframe.to_csv(csv_path, index=False)
    except Exception as e:
        print(f"Error writing CSV with lock: {e}")
        raise


def compute_sleep_score(row, goal_minutes):
    try:
        ma = row.get("minutesAsleep") or 0
        tib = row.get("timeInBed") or 0
        eff = row.get("efficiency")
        if eff is None and tib > 0:
            eff = 100.0 * ma / tib
        D = clamp(100.0 * (ma / goal_minutes) if goal_minutes else None)
        E = clamp(eff)
        latency = row.get("minutesToFallAsleep") or 0
        minutes_awake = row.get("minutesAwake") or 0
        C_raw = 100.0 - 0.5 * min(latency, 60) - 0.5 * minutes_awake
        C = clamp(C_raw)
        md = row.get("minutesDeep")
        mr = row.get("minutesREM")
        S = None
        if md is not None and mr is not None and ma:
            prop = (md + mr) / ma
            S = clamp(100.0 * max(0.0, min(1.0, (prop - 0.25) / 0.35)))
        parts = []
        weights = []
        if D is not None:
            parts.append(D); weights.append(0.4)
        if E is not None:
            parts.append(E); weights.append(0.3)
        if S is not None:
            parts.append(S); weights.append(0.2)
        if C is not None:
            parts.append(C); weights.append(0.1)
        if not parts:
            return None
        total_w = sum(weights)
        norm_weights = [w / total_w for w in weights]
        score = sum(p * w for p, w in zip(parts, norm_weights))
        return round(score, 1)
    except Exception:
        return None


def main():
    last_date = load_last_date()
    if last_date:
        start_date = last_date + timedelta(days=1)
        source = f"CSV (last date {last_date.strftime('%Y-%m-%d')})"
    else:
        # Use 90-day fallback directly - no need to fetch memberSince
        start_date = FALLBACK_START_DATE
        source = f"90-day fallback ({FALLBACK_START_DATE.strftime('%Y-%m-%d')})"
    
    print(f"Starting sleep fetch from {start_date.strftime('%Y-%m-%d')} (source: {source})")
    end_date = datetime.now()
    # Early exit if already up to date (no new dates to fetch)
    if start_date.date() > end_date.date():
        print("Up to date: no new dates to fetch.")
        return
    # Optional nicety when start and end fall on the same calendar day
    if start_date.date() == end_date.date():
        print("Nothing new since last run; waiting for tomorrow's data.")
    if os.path.exists(CSV_FILE):
        combined = pd.read_csv(CSV_FILE)
        if "date" in combined.columns:
            combined["date"] = pd.to_datetime(combined["date"]).dt.date
    else:
        combined = pd.DataFrame(columns=COLUMNS)
    token = get_access_token()
    goal_minutes = get_sleep_goal_minutes(token)
    
    # Track success/failure statistics
    total_chunks = 0
    successful_chunks = 0
    failed_chunks = 0
    initial_data_count = len(combined)
    
    print(f"Starting sleep data fetch from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")
    print(f"Current records in database: {initial_data_count}")
    print(f"Sleep goal: {goal_minutes} minutes")
    print("=" * 60)
    for start_str, end_str in daterange_chunks(start_date, end_date, CHUNK_DAYS):
        total_chunks += 1
        print(f"Fetching {start_str} to {end_str}...")
        
        json_data, token = fetch_sleep_chunk(start_str, end_str, token)
        
        # Check if fetch was successful
        if json_data is None:
            failed_chunks += 1
            print(f"Failed to fetch data for {start_str} to {end_str}")
            print(f"ERROR: Failed to fetch data for {start_str} to {end_str}")
            continue
            
        df = parse_sleep(json_data)
        if df.empty or "date" not in df.columns:
            print(f"Skipping invalid or empty chunk: {start_str} to {end_str}")
            failed_chunks += 1
            continue
        df["date"] = pd.to_datetime(df["date"]).dt.date
        df["logId"] = pd.to_numeric(df["logId"], errors="coerce").astype("Int64")
        df["sleepScore"] = df.apply(lambda r: compute_sleep_score(r.to_dict(), goal_minutes), axis=1)
        if not combined.empty:
            combined["logId"] = pd.to_numeric(combined.get("logId"), errors="coerce").astype("Int64")
            before = len(df)
            df = df[~df["logId"].isin(combined["logId"].dropna())]
            if before - len(df) > 0:
                print(f"De-dup: dropped {before - len(df)} existing logs by logId")
        # Handle DataFrame concatenation to avoid FutureWarning
        if combined.empty:
            combined = df.copy()
        else:
            # Ensure both DataFrames have the same columns before concatenation
            all_columns = list(set(combined.columns) | set(df.columns))
            for col in all_columns:
                if col not in combined.columns:
                    combined[col] = pd.NA
                if col not in df.columns:
                    df[col] = pd.NA
            
            # Reorder columns to match
            combined = combined[all_columns]
            df = df[all_columns]
            
            # Use append method instead of concat to avoid FutureWarning
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", FutureWarning)
                try:
                    combined = combined._append(df, ignore_index=True)
                except AttributeError:
                    # Fallback for older pandas versions
                    combined = pd.concat([combined, df], ignore_index=True)
        combined = combined.sort_values(["date", "isMainSleep"], ascending=[True, False])
        _safe_csv_write(CSV_FILE, combined)
        print(f"Saved chunk to {CSV_FILE} up to {end_str}")
        successful_chunks += 1
        time.sleep(RATE_LIMIT_DELAY)
    # Display appropriate completion message based on results
    final_data_count = len(combined)
    new_records = final_data_count - initial_data_count
    # ASCII-only summary to avoid console encoding issues
    if successful_chunks == 0:
        print("SUCCESS: No new data available - all data is already up to date.")
    elif failed_chunks > 0:
        print(f"WARNING: Partial success: {successful_chunks}/{total_chunks} chunks fetched successfully.")
        print(f"Added {new_records} new sleep records. Total records: {final_data_count}")
    else:
        print("SUCCESS: All available sleep data fetched and saved.")
        print(f"Added {new_records} new sleep records. Total records: {final_data_count}")


if __name__ == "__main__":
    main()
