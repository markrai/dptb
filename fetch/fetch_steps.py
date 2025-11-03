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
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from auth.refresh_token import refresh_token
from common.profile_paths import (
    get_active_profile,
    tokens_file_for,
    csv_path_for,
    ensure_dirs_for_csv,
)
from common.rate_limit import wait_until_next_hour_with_countdown, wait_seconds_with_countdown

# Resolve profile-scoped paths (legacy default if not provided)
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--profile", default=None)
args, _unknown = parser.parse_known_args()
PROFILE_ID = get_active_profile(args.profile)

TOKENS_FILE = tokens_file_for(PROFILE_ID)
CSV_FILE = csv_path_for(PROFILE_ID, "fitbit_activity.csv")
# Ensure env for refresh_token() and directories for CSV
os.environ["FITBIT_TOKENS_FILE"] = TOKENS_FILE
os.environ["FITBIT_PROFILE"] = PROFILE_ID or ""
ensure_dirs_for_csv(CSV_FILE)
CHUNK_DAYS = 90
FALLBACK_START_DATE = datetime.now() - timedelta(days=90)
RATE_LIMIT_DELAY = 2

def get_access_token():
    with open(TOKENS_FILE) as f:
        return json.load(f)["access_token"]

def load_last_date():
    if os.path.exists(CSV_FILE):
        try:
            df = pd.read_csv(CSV_FILE, usecols=["date"])
            if df.empty or "date" not in df.columns:
                return None
            dates = pd.to_datetime(df["date"], errors="coerce").dropna()
            if dates.empty:
                return None
            d = dates.max().date()
            return datetime(d.year, d.month, d.day)
        except Exception:
            return None
    return None

def daterange_chunks(start, end, delta_days):
    while start <= end:
        chunk_end = min(start + timedelta(days=delta_days - 1), end)
        yield start.strftime("%Y-%m-%d"), chunk_end.strftime("%Y-%m-%d")
        start += timedelta(days=delta_days)


def choose_fitbit_period(days: int) -> str:
    """Map day span to Fitbit period token to minimize calls."""
    d = max(1, int(days))
    if d <= 1:
        return "1d"
    if d <= 7:
        return "7d"
    if d <= 30:
        return "30d"
    if d <= 90:
        return "30d"  # Use 30d for 90 days - more reliable than 3m
    if d <= 366:
        return "1y"
    return "max"


def fetch_activity_period(end_str: str, period: str, token: str):
    """Fetch steps and sedentary minutes using period time series endpoints."""
    headers = {"Authorization": f"Bearer {token}"}

    # Steps (time series period)
    steps_url = f"https://api.fitbit.com/1/user/-/activities/steps/date/{end_str}/{period}.json"
    steps_data = None
    for attempt in range(3):
        try:
            res = requests.get(steps_url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout for steps (period {period} ending {end_str})")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error for steps: {e}")
            continue
        print(f"Steps response {res.status_code} for period {period} ending {end_str}")
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
            steps_data = res.json()
            break
        elif res.status_code == 429:
            try:
                reset_s = int(res.headers.get("fitbit-rate-limit-reset", "0"))
            except Exception:
                reset_s = 0
            if reset_s > 0 and reset_s < 300:  # Only wait if reset is less than 5 minutes
                wait_for = max(reset_s + 1, 1)
                print(f"429 rate limit. Using header-provided reset ({reset_s}s).")
                wait_seconds_with_countdown(wait_for, context="Header reset")
            else:
                print("429 rate limit. Period fetch failed, falling back to chunked method.")
                return None, None, token  # Fall back to chunked method instead of waiting
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
                        return None, None, token
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                    return None, None, token
        elif res.status_code == 404:
            print(f"WARNING: No activity data available for period {period} ending {end_str} (404 - Data not found)")
            print("   This is normal if your watch wasn't synced or no activity data was recorded.")
            # Return empty data instead of None to continue processing
            return {"activities-steps": []}, {"activities-minutesSedentary": []}, token
        elif res.status_code == 500:
            print(f"WARNING: Server error for period {period} ending {end_str} (500 - API error)")
            print("   This usually means the date range is too large. Will retry with smaller chunks.")
            # Return empty data to continue processing with smaller chunks
            return {"activities-steps": []}, {"activities-minutesSedentary": []}, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, None, token

    # Sedentary minutes (time series period)
    sedentary_url = f"https://api.fitbit.com/1/user/-/activities/minutesSedentary/date/{end_str}/{period}.json"
    sedentary_data = None
    for attempt in range(3):
        try:
            res = requests.get(sedentary_url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout for sedentary minutes (period {period} ending {end_str})")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error for sedentary minutes: {e}")
            continue
        print(f"Sedentary response {res.status_code} for period {period} ending {end_str}")
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
            sedentary_data = res.json()
            break
        elif res.status_code == 429:
            try:
                reset_s = int(res.headers.get("fitbit-rate-limit-reset", "0"))
            except Exception:
                reset_s = 0
            if reset_s > 0 and reset_s < 300:  # Only wait if reset is less than 5 minutes
                wait_for = max(reset_s + 1, 1)
                print(f"429 rate limit. Using header-provided reset ({reset_s}s).")
                wait_seconds_with_countdown(wait_for, context="Header reset")
            else:
                print("429 rate limit. Period fetch failed, falling back to chunked method.")
                return None, None, token  # Fall back to chunked method instead of waiting
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
                        return None, None, token
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                    return None, None, token
        elif res.status_code == 404:
            print(f"WARNING: No activity data available for period {period} ending {end_str} (404 - Data not found)")
            print("   This is normal if your watch wasn't synced or no activity data was recorded.")
            # Return empty data instead of None to continue processing
            return {"activities-steps": []}, {"activities-minutesSedentary": []}, token
        elif res.status_code == 500:
            print(f"WARNING: Server error for period {period} ending {end_str} (500 - API error)")
            print("   This usually means the date range is too large. Will retry with smaller chunks.")
            # Return empty data to continue processing with smaller chunks
            return {"activities-steps": []}, {"activities-minutesSedentary": []}, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, None, token

    return steps_data, sedentary_data, token

def fetch_activity_chunk(start_str, end_str, token):
    """Fetch both steps and sedentary minutes data for a date range"""
    headers = {"Authorization": f"Bearer {token}"}
    
    # Fetch steps data
    steps_url = f"https://api.fitbit.com/1/user/-/activities/steps/date/{start_str}/{end_str}.json"
    steps_data = None
    for attempt in range(3):
        try:
            res = requests.get(steps_url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout for steps {start_str} to {end_str}")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error for steps: {e}")
            continue
        print(f"Steps response {res.status_code} for {start_str} to {end_str}")
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
            steps_data = res.json()
            break
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
                wait_until_next_hour_with_countdown("Rate limited by Fitbit (steps)")
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
                    # After script run, reload access token from tokens file
                    try:
                        token = get_access_token()
                        headers = {"Authorization": f"Bearer {token}"}
                        print("Retrying request after running refresh_token.py...")
                        continue
                    except Exception as e2:
                        print(f"Failed to load access token after script: {e2}")
                        return None, None, token
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                    return None, None, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, None, token
    
    if steps_data is None:
        return None, None, token
    
    # Fetch sedentary minutes data
    sedentary_url = f"https://api.fitbit.com/1/user/-/activities/minutesSedentary/date/{start_str}/{end_str}.json"
    sedentary_data = None
    for attempt in range(3):
        try:
            res = requests.get(sedentary_url, headers=headers, timeout=30)
        except requests.exceptions.Timeout:
            print(f"Timeout for sedentary minutes {start_str} to {end_str}")
            continue
        except requests.exceptions.RequestException as e:
            print(f"Request error for sedentary minutes: {e}")
            continue
        print(f"Sedentary response {res.status_code} for {start_str} to {end_str}")
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
            sedentary_data = res.json()
            break
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
                wait_until_next_hour_with_countdown("Rate limited by Fitbit (sedentary)")
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
                    # After script run, reload access token from tokens file
                    try:
                        token = get_access_token()
                        headers = {"Authorization": f"Bearer {token}"}
                        print("Retrying request after running refresh_token.py...")
                        continue
                    except Exception as e2:
                        print(f"Failed to load access token after script: {e2}")
                        return None, None, token
                except Exception as se:
                    print(f"Failed to run refresh_token.py: {se}")
                    return None, None, token
        else:
            print(f"Error: {res.status_code} - {res.text}")
            return None, None, token
    
    return steps_data, sedentary_data, token

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


def parse_activity_data(steps_data, sedentary_data):
    """Parse both steps and sedentary minutes data into a combined DataFrame"""
    rows = []
    
    # Create a dictionary to store data by date
    data_by_date = {}
    
    # Parse steps data
    if steps_data and "activities-steps" in steps_data:
        for entry in steps_data["activities-steps"]:
            date = entry.get("dateTime")
            if date:
                data_by_date[date] = {"date": date, "steps": int(entry.get("value", 0) or 0)}
    
    # Parse sedentary minutes data
    if sedentary_data and "activities-minutesSedentary" in sedentary_data:
        for entry in sedentary_data["activities-minutesSedentary"]:
            date = entry.get("dateTime")
            if date:
                if date in data_by_date:
                    data_by_date[date]["sedentaryMinutes"] = int(entry.get("value", 0) or 0)
                else:
                    data_by_date[date] = {"date": date, "sedentaryMinutes": int(entry.get("value", 0) or 0)}
    
    # Convert to list of rows, ensuring all dates have both columns
    for date, data in data_by_date.items():
        row = {"date": date}
        row["steps"] = data.get("steps", 0)
        row["sedentaryMinutes"] = data.get("sedentaryMinutes", 0)
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
    
    print(f"Starting activity data fetch from {start_date.strftime('%Y-%m-%d')} (source: {source})")
    end_date = datetime.now() - timedelta(days=1)
    if start_date.date() > end_date.date():
        print("Up to date: no new activity dates to fetch.")
        return
    
    print(f"Fetching activity data (steps + sedentary minutes) from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")
    print("This may take a few minutes...")
    if os.path.exists(CSV_FILE):
        combined = pd.read_csv(CSV_FILE)
        if "date" in combined.columns:
            combined["date"] = pd.to_datetime(combined["date"])
        else:
            combined = pd.DataFrame()
    else:
        combined = pd.DataFrame()
    # Try a single period-based fetch to minimize API calls
    pending_days = (end_date.date() - start_date.date()).days + 1
    period = choose_fitbit_period(pending_days)
    end_str = end_date.strftime('%Y-%m-%d')
    print(f"Fetching activity data (steps + sedentary) using period {period} ending {end_str}...")
    # Synthetic range line for UI progress compatibility
    print(f"Fetching {start_date.strftime('%Y-%m-%d')} to {end_str}...")
    token = get_access_token()
    steps_data_p, sedentary_data_p, token = fetch_activity_period(end_str, period, token)
    if steps_data_p is not None and sedentary_data_p is not None:
        df_p = parse_activity_data(steps_data_p, sedentary_data_p)
        if not df_p.empty and "date" in df_p.columns:
            df_p["date"] = pd.to_datetime(df_p["date"])  # normalize
            # Keep only the pending window
            df_p = df_p[df_p["date"] >= pd.to_datetime(start_date.date())]
            initial_count = len(combined)
            combined = pd.concat([combined, df_p], ignore_index=True)
            combined = combined.drop_duplicates(subset=["date"]).sort_values("date")
            _safe_csv_write(CSV_FILE, combined)
            print(f"Saved activity to {CSV_FILE} up to {end_str}")
            final_count = len(combined)
            new_records = final_count - initial_count
            print("All available activity data fetched and saved.")
            print(f"Added {new_records} new activity records. Total: {final_count}")
            return
    # Fallback to legacy chunked range requests if period fetch failed
    token = get_access_token()
    total_chunks = 0
    successful_chunks = 0
    failed_chunks = 0
    initial_count = len(combined)
    for start_str, end_str in daterange_chunks(start_date, end_date, CHUNK_DAYS):
        total_chunks += 1
        print(f"Fetching activity data {start_str} to {end_str}...")
        steps_data, sedentary_data, token = fetch_activity_chunk(start_str, end_str, token)
        if steps_data is None or sedentary_data is None:
            failed_chunks += 1
            print(f"Failed to fetch data for {start_str} to {end_str}")
            continue
        df = parse_activity_data(steps_data, sedentary_data)
        if df.empty or "date" not in df.columns:
            failed_chunks += 1
            continue
        df["date"] = pd.to_datetime(df["date"])
        combined = pd.concat([combined, df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["date"]).sort_values("date")
        _safe_csv_write(CSV_FILE, combined)
        print(f"Saved activity chunk to {CSV_FILE} up to {end_str}")
        successful_chunks += 1
        time.sleep(RATE_LIMIT_DELAY)
    final_count = len(combined)
    new_records = final_count - initial_count
    # ASCII-only summary to avoid console encoding issues
    if successful_chunks == 0:
        print("SUCCESS: No new data available - all data is already up to date.")
    elif failed_chunks > 0:
        print(f"WARNING: Partial success: {successful_chunks}/{total_chunks} chunks fetched.")
        print(f"Added {new_records} new activity records. Total: {final_count}")
    else:
        print("SUCCESS: All available activity data fetched and saved.")
        print(f"Added {new_records} new activity records. Total: {final_count}")

if __name__ == "__main__":
    main()
