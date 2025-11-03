import os
import json
import time
import requests
import subprocess
import pandas as pd
from datetime import datetime, timedelta
import sys
import argparse
import fcntl
import os
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
CSV_FILE = csv_path_for(PROFILE_ID, "fitbit_hrv.csv")
os.environ["FITBIT_TOKENS_FILE"] = TOKENS_FILE
os.environ["FITBIT_PROFILE"] = PROFILE_ID or ""
ensure_dirs_for_csv(CSV_FILE)
CHUNK_DAYS = 30
FALLBACK_START_DATE = datetime.now() - timedelta(days=90)
RATE_LIMIT_DELAY = 2


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


def daterange_chunks(start, end, delta_days):
    while start <= end:
        chunk_end = min(start + timedelta(days=delta_days - 1), end)
        yield start.strftime('%Y-%m-%d'), chunk_end.strftime('%Y-%m-%d')
        start += timedelta(days=delta_days)


def fetch_hrv_chunk(start_str, end_str, token):
    url = f"https://api.fitbit.com/1/user/-/hrv/date/{start_str}/{end_str}.json"
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
                wait_until_next_hour_with_countdown("Rate limited by Fitbit (HRV)")
            continue
        elif res.status_code == 401:
            print("Access token expired. Refreshing...")
            try:
                token = refresh_token()
                headers = {"Authorization": f"Bearer {token}"}
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
            print(f"WARNING: No HRV data available for {start_str} to {end_str} (404 - Data not found)")
            print("   This is normal if your watch wasn't synced or no HRV data was recorded.")
            # Return empty data instead of None to continue processing
            return {"hrv": []}, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, token
    return None, token


def choose_fitbit_period(days: int) -> str:
    d = max(1, int(days))
    if d <= 1:
        return '1d'
    if d <= 7:
        return '7d'
    if d <= 30:
        return '30d'
    if d <= 90:
        return '3m'
    if d <= 180:
        return '6m'
    if d <= 366:
        return '1y'
    return 'max'


def fetch_hrv_period(end_str: str, period: str, token: str):
    url = f"https://api.fitbit.com/1/user/-/hrv/date/{end_str}/{period}.json"
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(3):
        try:
            res = requests.get(url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout: Fitbit API did not respond within 30 seconds for period {period} ending {end_str}")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error: {e}")
            continue
        print(f"Response {res.status_code} for period {period} ending {end_str}")
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
        if res.status_code == 200:
            return res.json(), token
        elif res.status_code == 429:
            try:
                reset_s = int(res.headers.get("fitbit-rate-limit-reset", "0"))
            except Exception:
                reset_s = 0
            if reset_s > 0:
                wait_for = max(reset_s + 1, 1)
                print("429 rate limit. Using header-provided reset.")
                wait_seconds_with_countdown(wait_for, context="Header reset")
            else:
                wait_until_next_hour_with_countdown("Rate limited by Fitbit (HRV)")
            continue
        elif res.status_code == 401:
            print("Access token expired. Refreshing...")
            try:
                token = refresh_token()
                headers = {"Authorization": f"Bearer {token}"}
            except Exception as e:
                print(f"Failed to refresh token: {e}")
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
            print(f"WARNING: No HRV data available for period {period} ending {end_str} (404 - Data not found)")
            print("   This is normal if your watch wasn't synced or no HRV data was recorded.")
            # Return empty data instead of None to continue processing
            return {"hrv": []}, token
        elif res.status_code == 500:
            print(f"WARNING: Server error for period {period} ending {end_str} (500 - API error)")
            print("   This usually means the date range is too large. Will retry with smaller chunks.")
            # Return empty data to continue processing with smaller chunks
            return {"hrv": []}, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, token
    return None, token


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


def parse_hrv(json_data):
    if not json_data or "hrv" not in json_data:
        return pd.DataFrame()

    rows = []
    for entry in json_data["hrv"]:
        row = {
            "date": entry.get("dateTime"),
            "dailyRmssd": entry["value"].get("dailyRmssd"),
            "deepRmssd": entry["value"].get("deepRmssd")
        }
        rows.append(row)
    return pd.DataFrame(rows)


def main():
    last_date = load_last_date()
    if last_date:
        start_date = last_date + timedelta(days=1)
        source = f"CSV (last date {last_date.strftime('%Y-%m-%d')})"
    else:
        # Use 90-day fallback directly - no need to fetch memberSince
        start_date = FALLBACK_START_DATE
        source = f"90-day fallback ({FALLBACK_START_DATE.strftime('%Y-%m-%d')})"
    
    print(f"Starting HRV fetch from {start_date.strftime('%Y-%m-%d')} (source: {source})")
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
            combined["date"] = pd.to_datetime(combined["date"])
        else:
            combined = pd.DataFrame()
    else:
        combined = pd.DataFrame()

    # Try period-based time series to reduce calls
    pending_days = (end_date.date() - start_date.date()).days + 1
    period = choose_fitbit_period(pending_days)
    end_str = end_date.strftime('%Y-%m-%d')
    # Synthetic range line for UI progress
    print(f"Fetching {start_date.strftime('%Y-%m-%d')} to {end_str}...")
    token = get_access_token()
    json_data_p, token = fetch_hrv_period(end_str, period, token)
    if json_data_p is not None:
        df_p = parse_hrv(json_data_p)
        if not df_p.empty and "date" in df_p.columns:
            df_p["date"] = pd.to_datetime(df_p["date"])  # normalize
            df_p = df_p[df_p["date"] >= pd.to_datetime(start_date.date())]
            initial_data_count = len(combined)
            combined = pd.concat([combined, df_p], ignore_index=True)
            combined = combined.drop_duplicates(subset=["date"]).sort_values("date")
            combined.to_csv(CSV_FILE, index=False)
            print(f"Saved chunk to {CSV_FILE} up to {end_str}")
            final_data_count = len(combined)
            new_records = final_data_count - initial_data_count
            print("All available HRV data fetched and saved.")
            print(f"Added {new_records} new HRV records. Total records: {final_data_count}")
            return

    token = get_access_token()
    
    # Track success/failure statistics
    total_chunks = 0
    successful_chunks = 0
    failed_chunks = 0
    token_refresh_failures = 0
    initial_data_count = len(combined)

    for start_str, end_str in daterange_chunks(start_date, end_date, CHUNK_DAYS):
        total_chunks += 1
        print(f"Fetching {start_str} to {end_str}...")
        
        json_data, token = fetch_hrv_chunk(start_str, end_str, token)
        
        # Check if fetch was successful
        if json_data is None:
            failed_chunks += 1
            print(f"Failed to fetch data for {start_str} to {end_str}")
            print(f"ERROR: Failed to fetch data for {start_str} to {end_str}")
            continue
            
        df = parse_hrv(json_data)

        if df.empty or "date" not in df.columns:
            print(f"Skipping invalid or empty chunk: {start_str} to {end_str}")
            failed_chunks += 1
            continue

        df["date"] = pd.to_datetime(df["date"])
        combined = pd.concat([combined, df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["date"]).sort_values("date")
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
        print(f"Added {new_records} new HRV records. Total records: {final_data_count}")
    else:
        print("SUCCESS: All available HRV data fetched and saved.")
        print(f"Added {new_records} new HRV records. Total records: {final_data_count}")


if __name__ == "__main__":
    main()
