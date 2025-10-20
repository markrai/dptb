#!/usr/bin/env python3
"""
FitBaus Flask Server
Replaces the built-in HTTP server with Flask to support API endpoints
while maintaining all existing static file serving functionality.
"""

import os
import subprocess
import threading
import json
import time
from datetime import datetime, date
from flask import Flask, send_from_directory, send_file, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Enable CORS for API endpoints

# Global state for tracking fetch operations
class FetchJobsDict(dict):
    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
    
    def __setitem__(self, key, value):
        with self._lock:
            print(f"[DEBUG] Setting fetch_jobs[{key}] = {value.get('status', 'unknown') if isinstance(value, dict) else value}")
            super().__setitem__(key, value)
            print(f"[DEBUG] fetch_jobs keys after set: {list(self.keys())}")
    
    def __delitem__(self, key):
        with self._lock:
            print(f"[DEBUG] Deleting fetch_jobs[{key}]")
            super().__delitem__(key)
            print(f"[DEBUG] fetch_jobs keys after delete: {list(self.keys())}")
    
    def clear(self):
        with self._lock:
            print(f"[DEBUG] WARNING: fetch_jobs.clear() called! Keys before clear: {list(self.keys())}")
            print(f"[DEBUG] WARNING: Stack trace for clear() call:")
            import traceback
            traceback.print_stack()
            super().clear()
            print(f"[DEBUG] fetch_jobs cleared - now empty")
    
    def pop(self, key, default=None):
        with self._lock:
            if key in self:
                print(f"[DEBUG] Popping fetch_jobs[{key}]")
                result = super().pop(key, default)
                print(f"[DEBUG] fetch_jobs keys after pop: {list(self.keys())}")
                return result
            return default

fetch_jobs = FetchJobsDict()

# Add a check to see if fetch_jobs gets reassigned
_original_fetch_jobs = fetch_jobs
def check_fetch_jobs_reassignment():
    global fetch_jobs
    if fetch_jobs is not _original_fetch_jobs:
        print(f"[DEBUG] WARNING: fetch_jobs has been reassigned! Original: {_original_fetch_jobs}, Current: {fetch_jobs}")
        print(f"[DEBUG] WARNING: Stack trace for reassignment:")
        import traceback
        traceback.print_stack()
        fetch_jobs = _original_fetch_jobs  # Restore original
# Track running fetch subprocesses by job_id for cancellation
fetch_procs = {}
job_counter = 0

# Global state for tracking authorization operations
auth_jobs = {}
auth_job_counter = 0

# Verbose logging configuration
VERBOSE_FETCH_LOGGING = True  # Set to False to disable verbose fetch logging

def _log_fetch(job_id: str, message: str, level: str = "INFO"):
    """Helper function for verbose fetch logging"""
    if VERBOSE_FETCH_LOGGING:
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] [FETCH-{job_id}] [{level}] {message}")

def _parse_date(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def run_fetch_script(profile_id, job_id):
    """Run fetch_all.py script in background thread with live status updates"""
    try:
        print(f"[DEBUG] Thread started for job {job_id}")
        print(f"[DEBUG] Current fetch_jobs keys at thread start: {list(fetch_jobs.keys())}")
        
        # Check if job exists at thread start
        if job_id not in fetch_jobs:
            print(f"[DEBUG] ERROR: Job {job_id} not found at thread start!")
            return
        
        _log_fetch(job_id, f"Starting fetch operation for profile: {profile_id}")
        _log_fetch(job_id, f"Job created at: {datetime.now().isoformat()}")
        
        # Update job status
        print(f"[DEBUG] Updating job {job_id} status to running")
        if job_id not in fetch_jobs:
            print(f"[DEBUG] ERROR: Job {job_id} not found in fetch_jobs during status update!")
            print(f"[DEBUG] Available jobs: {list(fetch_jobs.keys())}")
            return
        fetch_jobs[job_id]['status'] = 'running'
        fetch_jobs[job_id]['start_time'] = datetime.now().isoformat()
        print(f"[DEBUG] Job {job_id} status updated, fetch_jobs keys: {list(fetch_jobs.keys())}")
        # Initialize progress-related fields
        fetch_jobs[job_id]['current_csv'] = None
        fetch_jobs[job_id]['start_date'] = None
        fetch_jobs[job_id]['last_date'] = None
        fetch_jobs[job_id]['progress'] = 0.0
        fetch_jobs[job_id]['current_script'] = None
        fetch_jobs[job_id]['message'] = 'Preparing fetch'
        # Throttling state (API rate limit/backoff)
        fetch_jobs[job_id]['throttle_active'] = False
        fetch_jobs[job_id]['throttle_reason'] = None
        fetch_jobs[job_id]['throttle_mmss'] = None
        fetch_jobs[job_id]['throttle_until'] = None
        
        _log_fetch(job_id, "Job state initialized - status: running")
        
        # Check if profile needs re-authorization first
        tokens_file = f'profiles/{profile_id}/auth/tokens.json'
        print(f"[FETCH-{job_id}] Checking tokens file: {tokens_file}")
        if not os.path.exists(tokens_file):
            print(f"[FETCH-{job_id}] ERROR: Profile {profile_id} not found. Go to Profile Management -> New Profile")
            fetch_jobs[job_id]['status'] = 'failed'
            fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
            fetch_jobs[job_id]['error'] = f'Profile {profile_id} not found. Go to Profile Management -> New Profile'
            return
        print(f"[FETCH-{job_id}] Tokens file found, proceeding with validation")
        
        # Check if profile has valid tokens before attempting refresh
        
        try:
            import json
            print(f"[FETCH-{job_id}] Loading tokens from file...")
            with open(tokens_file, 'r') as f:
                tokens = json.load(f)
            
            print(f"[FETCH-{job_id}] Tokens loaded successfully. Keys: {list(tokens.keys()) if tokens else 'empty'}")
            
            # Check if tokens file is empty or missing refresh token
            if not tokens or 'refresh_token' not in tokens or not tokens.get('refresh_token'):
                print(f"[FETCH-{job_id}] ERROR: Profile {profile_id} needs authorization. Tokens: {tokens}")
                fetch_jobs[job_id]['status'] = 'failed'
                fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
                fetch_jobs[job_id]['error'] = f'Profile {profile_id} needs authorization. Go to Profile Management -> Existing Profiles -> Auth'
                return
            print(f"[FETCH-{job_id}] Tokens validation passed, refresh_token present")
            
            # Try to refresh the token first
            print(f"[FETCH-{job_id}] Attempting to refresh token for profile {profile_id}...")
            
            # Set environment variable for profile
            env = os.environ.copy()
            env['FITBIT_PROFILE'] = profile_id
            env['PYTHONIOENCODING'] = 'utf-8'
            env['PYTHONUNBUFFERED'] = '1'
            
            print(f"[FETCH-{job_id}] Running token refresh subprocess...")
            refresh_result = subprocess.run(
                ['python', 'auth/refresh_token.py'],
                cwd=os.getcwd(),
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                env=env,
                timeout=30
            )
            print(f"[FETCH-{job_id}] Token refresh completed. Return code: {refresh_result.returncode}")
            
            if refresh_result.returncode != 0:
                print(f"Token refresh failed for profile {profile_id}. Re-authorization needed.")
                print(f"Refresh error: {refresh_result.stderr}")
                
                # Extract the specific error message from stderr, clean it up
                error_msg = refresh_result.stderr.strip()
                if not error_msg:
                    error_msg = refresh_result.stdout.strip()
                if not error_msg:
                    error_msg = "Token refresh failed"
                
                # Clean up the error message to remove file paths and verbose details
                if "[fitbit] Error:" in error_msg:
                    error_msg = error_msg.split("[fitbit] Error:")[-1].strip()
                if "Token file not found:" in error_msg:
                    error_msg = "Token file not found"
                if "Refresh token is invalid or expired" in error_msg:
                    error_msg = "Refresh token is invalid or expired"
                
                fetch_jobs[job_id]['status'] = 'failed'
                fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
                fetch_jobs[job_id]['error'] = f'Token refresh failed: {error_msg}. Go to Profile Management -> Existing Profiles -> Auth'
                return
            else:
                print(f"Token refresh successful for profile {profile_id}")
                print(f"Refresh output: {refresh_result.stdout}")
                
        except Exception as e:
            print(f"Error checking/refreshing tokens for profile {profile_id}: {e}")
            fetch_jobs[job_id]['status'] = 'failed'
            fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
            fetch_jobs[job_id]['error'] = f'Error checking tokens: {e}'
            return
        
        # Prepare command
        cmd = ['python', 'fetch/fetch_all.py']
        if profile_id:
            cmd.extend(['--profile', profile_id])
        
        print(f"Running command: {' '.join(cmd)}")
        print(f"Working directory: {os.getcwd()}")
        print(f"Profile ID: {profile_id}")
        
        # Set environment variables for proper Unicode handling
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        env['PYTHONUNBUFFERED'] = '1'
        
        print("=" * 60)
        print("FETCH SCRIPT OUTPUT:")
        print("=" * 60)
        
        # Check if job still exists before starting subprocess
        if job_id not in fetch_jobs:
            print(f"[DEBUG] ERROR: Job {job_id} not found before subprocess start!")
            print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
            return
        
        # Stream the script output to update progress
        proc = subprocess.Popen(
            cmd,
            cwd=os.getcwd(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=0,  # Unbuffered for immediate output
            universal_newlines=True,
            encoding='utf-8',
            errors='replace',
            env=env,
        )
        # Record process handle for potential cancellation
        fetch_procs[job_id] = proc

        # Track and parse progress from child output
        output_lines: list[str] = []
        # Map script names to CSV file names
        script_to_csv = {
            'fetch_steps.py': 'fitbit_activity.csv',
            'fetch_rhr_data.py': 'fitbit_rhr.csv',
            'fetch_hrv_data.py': 'fitbit_hrv.csv',
            'fetch_sleep_data.py': 'fitbit_sleep.csv',
            'fetch_sleep_data_alternate_version.py': 'fitbit_sleep.csv',
        }

        def update_progress_for(last_date_str: str | None):
            try:
                sd_str = fetch_jobs[job_id].get('start_date')
                if not sd_str:
                    return
                start_d = _parse_date(sd_str)
                if not start_d:
                    return
                today_d = date.today()
                # If last_date not provided yet, do a tiny non-zero to show activity
                if last_date_str:
                    last_d = _parse_date(last_date_str)
                else:
                    last_d = None
                if not last_d:
                    last_d = start_d
                total_days = max((today_d - start_d).days, 1)
                done_days = max((min(last_d, today_d) - start_d).days, 0)
                progress = max(0.0, min(1.0, done_days / total_days))
                fetch_jobs[job_id]['progress'] = progress
            except Exception:
                pass

        assert proc.stdout is not None
        buffer = ""
        for raw in proc.stdout:
            # Process character by character for real-time updates
            buffer += raw
            # Send complete lines immediately
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.rstrip("\r")
                output_lines.append(line)
                # Debug: print what we're capturing
                print(f"[FETCH-{job_id}] CAPTURED: {line}")
                print(f"[DEBUG] Raw output length: {len(fetch_jobs[job_id].get('raw_output', []))}")
                
                # Send real-time update to terminal
                if job_id in fetch_jobs:
                    fetch_jobs[job_id]['raw_output'] = fetch_jobs[job_id].get('raw_output', [])
                    fetch_jobs[job_id]['raw_output'].append(line)
                    # Keep only last 100 lines to prevent memory issues
                    if len(fetch_jobs[job_id]['raw_output']) > 100:
                        fetch_jobs[job_id]['raw_output'] = fetch_jobs[job_id]['raw_output'][-100:]
            
            # Check if job still exists during output processing
            if job_id not in fetch_jobs:
                print(f"[DEBUG] ERROR: Job {job_id} disappeared during output processing!")
                print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
                break
            # Lightweight parsing of progress-relevant lines
            low = line.lower()
            # Detect which script is running
            # Pattern: "[i/N] Starting fetch_xxx.py..." from fetch_all.py
            if 'starting' in low and 'fetch_' in low and low.endswith('...'):
                try:
                    name = line.split('Starting', 1)[1].strip().strip('.').strip('.').strip()
                    # name may include ellipsis; reduce to the script filename
                    parts = name.split()
                    script_name = parts[0] if parts else ''
                    if script_name in script_to_csv:
                        fetch_jobs[job_id]['current_script'] = script_name
                        fetch_jobs[job_id]['current_csv'] = script_to_csv[script_name]
                        fetch_jobs[job_id]['message'] = f"Running {script_name}"
                except Exception:
                    pass

            # Starting range lines per script
            # Steps: Starting activity data fetch from YYYY-MM-DD
            if 'starting activity data fetch from ' in low:
                try:
                    idx = low.index('starting activity data fetch from ')
                    date_str = line[idx:].split('from',1)[1].strip().split()[0]
                    fetch_jobs[job_id]['start_date'] = date_str
                    fetch_jobs[job_id]['message'] = f"Activity from {date_str}"
                    update_progress_for(None)
                except Exception:
                    pass
            # RHR: Starting resting HR fetch from YYYY-MM-DD
            if 'starting resting hr fetch from ' in low:
                try:
                    idx = low.index('starting resting hr fetch from ')
                    date_str = line[idx:].split('from',1)[1].strip().split()[0]
                    fetch_jobs[job_id]['start_date'] = date_str
                    fetch_jobs[job_id]['message'] = f"RHR from {date_str}"
                    update_progress_for(None)
                except Exception:
                    pass
            # HRV: Starting HRV fetch from YYYY-MM-DD
            if 'starting hrv fetch from ' in low:
                try:
                    idx = low.index('starting hrv fetch from ')
                    date_str = line[idx:].split('from',1)[1].strip().split()[0]
                    fetch_jobs[job_id]['start_date'] = date_str
                    fetch_jobs[job_id]['message'] = f"HRV from {date_str}"
                    update_progress_for(None)
                except Exception:
                    pass
            # Sleep: Starting sleep data fetch from YYYY-MM-DD to YYYY-MM-DD
            if 'starting sleep data fetch from ' in low:
                try:
                    idx = low.index('starting sleep data fetch from ')
                    rest = line[idx:].split('from',1)[1].strip()
                    date_str = rest.split()[0]
                    fetch_jobs[job_id]['start_date'] = date_str
                    fetch_jobs[job_id]['message'] = f"Sleep from {date_str}"
                    update_progress_for(None)
                except Exception:
                    pass

            # Chunk lines: "Fetching yyyy-mm-dd to yyyy-mm-dd..."
            # Do not update last_date here; this line often prints the target end (e.g., today)
            # before any data is actually saved, which can briefly show 100%.
            # We rely on "Saved ... up to YYYY-MM-DD" lines to advance progress accurately.
            if 'fetching ' in low and ' to ' in low:
                try:
                    # Optionally update the message to reflect current activity without affecting progress
                    parts = line.strip().split()
                    dates = [p for p in parts if len(p) == 10 and p[4] == '-' and p[7] == '-']
                    if len(dates) >= 2:
                        start_candidate = dates[0]
                        end_candidate = dates[1]
                        if _parse_date(start_candidate) and _parse_date(end_candidate):
                            fetch_jobs[job_id]['message'] = f"Fetching {start_candidate} → {end_candidate}"
                except Exception:
                    pass

            # Saved lines: capture CSV and last date: "Saved ... to <csv> up to YYYY-MM-DD"
            if 'saved ' in low and ' to ' in low:
                try:
                    # Try to infer CSV filename
                    parts = line.strip().split()
                    csv_tokens = [p for p in parts if p.endswith('.csv')]
                    if csv_tokens:
                        fetch_jobs[job_id]['current_csv'] = os.path.basename(csv_tokens[-1])
                except Exception:
                    pass
            if ' up to ' in low:
                try:
                    after = line.lower().split(' up to ', 1)[1]
                    end_str = after.strip().split()[0]
                    # Validate date
                    if _parse_date(end_str):
                        fetch_jobs[job_id]['last_date'] = end_str
                        update_progress_for(end_str)
                except Exception:
                    pass

            # Detect throttling/backoff and countdowns
            # Header-provided reset seconds
            if 'rate-limit headers indicate reset in ' in low and 's' in low:
                try:
                    # e.g., "Rate-limit headers indicate reset in 27s."
                    import re
                    m = re.search(r"reset in\s+(\d+)s", low)
                    if m:
                        secs = int(m.group(1))
                        from datetime import timedelta
                        until = (datetime.now() + timedelta(seconds=secs)).strftime('%Y-%m-%d %H:%M:%S')
                        _log_fetch(job_id, f"THROTTLE: Rate-limit headers indicate reset in {secs}s (until {until})", "THROTTLE")
                        fetch_jobs[job_id]['throttle_active'] = True
                        fetch_jobs[job_id]['throttle_reason'] = 'Header reset'
                        fetch_jobs[job_id]['throttle_until'] = until
                        fetch_jobs[job_id]['throttle_mmss'] = None
                except Exception as e:
                    print(f"[FETCH-{job_id}] ERROR parsing rate-limit reset: {e}")
                    pass
            # Header reset countdown: "Header reset for Xs..."
            if 'header reset for ' in low and 's...' in low:
                try:
                    # e.g., "Header reset for 1200s..."
                    import re
                    m = re.search(r"header reset for\s+(\d+)s", low)
                    if m:
                        secs = int(m.group(1))
                        from datetime import timedelta
                        until = (datetime.now() + timedelta(seconds=secs)).strftime('%Y-%m-%d %H:%M:%S')
                        print(f"[FETCH-{job_id}] THROTTLE: Header reset for {secs}s (until {until})")
                        fetch_jobs[job_id]['throttle_active'] = True
                        fetch_jobs[job_id]['throttle_reason'] = 'Header reset'
                        fetch_jobs[job_id]['throttle_until'] = until
                        fetch_jobs[job_id]['throttle_mmss'] = None
                except Exception as e:
                    print(f"[FETCH-{job_id}] ERROR parsing header reset: {e}")
                    pass
            # Top-of-hour wait message
            if 'waiting until ' in low and 'top of hour' in low:
                try:
                    # e.g., "Waiting until 14:00:05 (top of hour + 5s)..."
                    after = low.split('waiting until ', 1)[1]
                    until = after.split()[0]
                    # Extract reason prefix (text before ". Waiting") if present
                    reason = line.split('. Waiting', 1)[0]
                    print(f"[FETCH-{job_id}] THROTTLE: {reason} - waiting until {until} (top of hour)")
                    fetch_jobs[job_id]['throttle_active'] = True
                    fetch_jobs[job_id]['throttle_reason'] = reason
                    fetch_jobs[job_id]['throttle_until'] = until
                    fetch_jobs[job_id]['throttle_mmss'] = None
                except Exception as e:
                    print(f"[FETCH-{job_id}] ERROR parsing top-of-hour wait: {e}")
                    pass
            # Generic countdown: "Retrying in MM:SS" - only update throttle_mmss occasionally
            if 'retrying in ' in low:
                try:
                    # Only update throttle_mmss every 10 seconds to reduce server load
                    import time
                    current_time = time.time()
                    last_update = fetch_jobs[job_id].get('_last_countdown_update', 0)
                    
                    if current_time - last_update >= 10:  # Update every 10 seconds
                        # Extract last token like 12:34
                        parts = line.strip().split()
                        mmss = None
                        for p in parts[::-1]:
                            if len(p) == 5 and p[2] == ':' and p[:2].isdigit() and p[3:].isdigit():
                                mmss = p
                                break
                        if mmss:
                            current_reason = fetch_jobs[job_id].get('throttle_reason', 'Backoff')
                            print(f"[FETCH-{job_id}] THROTTLE: {current_reason} - retrying in {mmss}")
                            fetch_jobs[job_id]['throttle_active'] = True
                            # Keep existing reason if set; otherwise generic
                            if not fetch_jobs[job_id].get('throttle_reason'):
                                fetch_jobs[job_id]['throttle_reason'] = 'Backoff'
                            fetch_jobs[job_id]['throttle_mmss'] = mmss
                            fetch_jobs[job_id]['_last_countdown_update'] = current_time
                except Exception as e:
                    print(f"[FETCH-{job_id}] ERROR parsing retry countdown: {e}")
                    pass
            # Countdown completion
            if low.strip() == 'resuming...':
                print(f"[FETCH-{job_id}] THROTTLE: Resuming after throttling period")
                fetch_jobs[job_id]['throttle_active'] = False
                fetch_jobs[job_id]['throttle_reason'] = None
                fetch_jobs[job_id]['throttle_mmss'] = None
                fetch_jobs[job_id]['throttle_until'] = None

        return_code = proc.wait()
        print(f"[FETCH-{job_id}] Process completed with return code: {return_code}")
        print(f"[FETCH-{job_id}] Job status before finalization: {fetch_jobs.get(job_id, {}).get('status', 'NOT_FOUND')}")

        # Finalize job
        out_text = "\n".join(output_lines)
        print(f"[FETCH-{job_id}] STORED OUTPUT LENGTH: {len(out_text)} characters")
        print(f"[FETCH-{job_id}] STORED OUTPUT PREVIEW: {out_text[:200]}...")
        print(f"[FETCH-{job_id}] RETURN CODE: {return_code}")
        if job_id in fetch_jobs:
            fetch_jobs[job_id]['status'] = 'completed' if return_code == 0 else 'failed'
            fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
            fetch_jobs[job_id]['return_code'] = return_code
            fetch_jobs[job_id]['output'] = out_text
            fetch_jobs[job_id]['error'] = None
            
            print(f"[FETCH-{job_id}] Job finalized with status: {fetch_jobs[job_id]['status']}")
        else:
            print(f"[FETCH-{job_id}] ERROR: Job {job_id} not found in fetch_jobs during finalization!")
        
        if return_code == 0:
            print(f"[FETCH-{job_id}] SUCCESS: Fetch completed successfully for profile {profile_id}")
        else:
            print(f"[FETCH-{job_id}] ERROR: Fetch failed for profile {profile_id} with exit code {return_code}")

    except subprocess.TimeoutExpired:
        print(f"[FETCH-{job_id}] TIMEOUT: Script execution timed out after 5 minutes")
        if job_id in fetch_jobs:
            fetch_jobs[job_id]['status'] = 'timeout'
            fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
            fetch_jobs[job_id]['error'] = 'Script execution timed out after 5 minutes'
        else:
            print(f"[FETCH-{job_id}] ERROR: Job {job_id} not found in fetch_jobs during timeout handling")
    except Exception as e:
        print(f"[FETCH-{job_id}] EXCEPTION: {str(e)}")
        print(f"[FETCH-{job_id}] Exception type: {type(e).__name__}")
        import traceback
        print(f"[FETCH-{job_id}] Traceback: {traceback.format_exc()}")
        if job_id in fetch_jobs:
            fetch_jobs[job_id]['status'] = 'error'
            fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
            fetch_jobs[job_id]['error'] = str(e)
        else:
            print(f"[FETCH-{job_id}] ERROR: Job {job_id} not found in fetch_jobs during exception handling")
    finally:
        # Only clear proc handle if job is actually completed/failed
        try:
            if fetch_jobs.get(job_id, {}).get('status') in ['completed', 'failed', 'timeout', 'error', 'cancelled']:
                fetch_procs.pop(job_id, None)
                
                # Schedule job cleanup after a delay to allow frontend to check final status
                def cleanup_job():
                    import time
                    time.sleep(10)  # Wait 10 seconds before removing the job
                    if job_id in fetch_jobs:
                        print(f"[DEBUG] Cleaning up completed job {job_id} after delay")
                        del fetch_jobs[job_id]
                
                threading.Thread(target=cleanup_job, daemon=True).start()
        except Exception:
            pass

# Static file serving (maintains existing behavior)
@app.route('/')
def index():
    """Serve the main spousal.html app"""
    return send_file('spousal.html')

@app.route('/favicon.ico')
def favicon():
    """Serve favicon with proper MIME type"""
    return send_file('assets/favicon.ico', mimetype='image/x-icon')

@app.route('/<path:filename>')
def static_files(filename):
    """Serve static files with proper MIME types"""
    try:
        # Check if file exists before trying to serve it
        if not os.path.exists(filename):
            return "File not found", 404
            
        # Handle CSV files with proper MIME type
        if filename.endswith('.csv'):
            return send_file(filename, mimetype='text/csv')
        # Handle JSON files
        elif filename.endswith('.json'):
            return send_file(filename, mimetype='application/json')
        # Handle other static files
        else:
            return send_from_directory('.', filename)
    except FileNotFoundError:
        return "File not found", 404
    except Exception as e:
        return f"Error serving file: {str(e)}", 500

# Profile-specific CSV serving
@app.route('/profiles/<profile_id>/csv/<filename>')
def serve_profile_csv(profile_id, filename):
    """Serve CSV files from profile directories"""
    file_path = f'profiles/{profile_id}/csv/{filename}'
    if os.path.exists(file_path):
        return send_file(file_path, mimetype='text/csv')
    return "File not found", 404

# API Endpoints
@app.route('/api/create-profile', methods=['POST'])
def create_profile():
    """Create a new profile with client credentials"""
    try:
        data = request.get_json()
        profile_name = data.get('profileName', '').strip()
        client_id = data.get('clientId', '').strip()
        client_secret = data.get('clientSecret', '').strip()
        
        # Validate inputs
        if not profile_name or not client_id or not client_secret:
            return jsonify({'error': 'All fields are required'}), 400
        
        # Validate profile name (alphanumeric, hyphens, underscores only)
        import re
        if not re.match(r'^[a-zA-Z0-9_-]+$', profile_name):
            return jsonify({'error': 'Profile name can only contain letters, numbers, hyphens, and underscores'}), 400
        
        # Check if profile already exists
        profile_dir = f'profiles/{profile_name}'
        if os.path.exists(profile_dir):
            return jsonify({'error': f'Profile "{profile_name}" already exists'}), 400
        
        # Create profile directory structure
        try:
            os.makedirs(f'{profile_dir}/auth', exist_ok=True)
            os.makedirs(f'{profile_dir}/csv', exist_ok=True)
        except PermissionError as pe:
            # Provide a helpful message for common Docker-on-Linux bind-mount issues
            msg = (
                "Permission denied creating profile directories. If running with Docker on Linux, "
                "ensure the host 'profiles' directory is writable by the container user (uid 10001). "
                "Try one of: `sudo chown -R 10001:10001 profiles`, or set `user: \"${UID:-10001}:${GID:-10001}\"` "
                "in docker-compose.yml, or relax permissions: `chmod -R 775 profiles`."
            )
            print(f"Error creating profile (permissions): {pe}")
            return jsonify({
                'error': 'Failed to create profile: permission denied',
                'hint': msg
            }), 500
        
        # Save client credentials with creation timestamp
        client_creds = {
            'client_id': client_id,
            'client_secret': client_secret,
            'created_at': datetime.now().isoformat()
        }
        
        with open(f'{profile_dir}/auth/client.json', 'w') as f:
            json.dump(client_creds, f, indent=2)
        
        # Create empty tokens file
        with open(f'{profile_dir}/auth/tokens.json', 'w') as f:
            json.dump({}, f)
        
        print(f"Created profile: {profile_name}")
        return jsonify({'message': f'Profile "{profile_name}" created successfully', 'profileName': profile_name})
        
    except PermissionError as e:
        # Catch any remaining permission errors (e.g., opening files)
        print(f"Error creating profile (permissions): {e}")
        return jsonify({
            'error': 'Failed to create profile: permission denied',
            'hint': (
                "Ensure the 'profiles' directory is writable. On Docker/Linux: "
                "`sudo chown -R 10001:10001 profiles` or set `user: \"${UID:-10001}:${GID:-10001}\"` in docker-compose.yml."
            )
        }), 500
    except Exception as e:
        print(f"Error creating profile: {e}")
        return jsonify({'error': f'Failed to create profile: {str(e)}'}), 500

@app.route('/api/delete-profile', methods=['POST'])
def delete_profile():
    """Delete a specific profile using the reset script"""
    try:
        data = request.get_json()
        profile_name = data.get('profileName', '').strip()
        
        if not profile_name:
            return jsonify({'error': 'Profile name is required'}), 400
        
        # Validate profile name (alphanumeric, hyphens, underscores only)
        import re
        if not re.match(r'^[a-zA-Z0-9_-]+$', profile_name):
            return jsonify({'error': 'Invalid profile name format'}), 400
        
        # Check if profile exists
        profile_dir = f'profiles/{profile_name}'
        if not os.path.exists(profile_dir):
            return jsonify({'error': f'Profile "{profile_name}" not found'}), 404
        
        # Cancel any running or queued fetch jobs for this profile to avoid recreation during deletion
        try:
            to_cancel = []
            for jid, job in list(fetch_jobs.items()):
                if job.get('profile') == profile_name and job.get('status') in ('queued', 'running'):
                    to_cancel.append(jid)
            for jid in to_cancel:
                proc = fetch_procs.get(jid)
                if proc and proc.poll() is None:
                    try:
                        proc.terminate()
                        # Give it a moment to exit
                        try:
                            proc.wait(timeout=5)
                        except Exception:
                            proc.kill()
                    except Exception as e:
                        print(f"Warning: failed to terminate fetch job {jid} for profile {profile_name}: {e}")
                # Mark job as cancelled
                try:
                    fetch_jobs[jid]['status'] = 'cancelled'
                    fetch_jobs[jid]['end_time'] = datetime.now().isoformat()
                    fetch_jobs[jid]['error'] = 'Cancelled due to profile deletion'
                except Exception:
                    pass
        except Exception as e:
            print(f"Warning: error while cancelling fetch jobs for {profile_name}: {e}")
        
        # Run the reset script with --profile parameter in non-interactive mode
        import subprocess
        result = subprocess.run(
            ['python', 'reset.py', '--profile', profile_name, '--yes'],
            cwd=os.getcwd(),
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=30
        )
        
        if result.returncode == 0:
            print(f"Successfully deleted profile: {profile_name}")
            # After deletion, try to sync profiles/index.json
            try:
                import sys
                sys.path.append('auth')
                from authorize_fitbit import sync_existing_profiles  # type: ignore
                sync_existing_profiles()
            except Exception as e:
                print(f"Warning: could not sync profiles/index.json after delete: {e}")
            return jsonify({'message': f'Profile "{profile_name}" deleted successfully'})
        else:
            error_msg = result.stderr or result.stdout or 'Unknown error'
            print(f"Failed to delete profile {profile_name}: {error_msg}")
            return jsonify({'error': f'Failed to delete profile: {error_msg}'}), 500
        
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Profile deletion timed out'}), 500
    except Exception as e:
        print(f"Error deleting profile: {e}")
        return jsonify({'error': f'Failed to delete profile: {str(e)}'}), 500

@app.route('/api/fetch-data', methods=['POST'])
def fetch_data():
    """Start a data fetch operation"""
    global job_counter
    
    data = request.get_json() or {}
    profile_id = data.get('profile', None)
    
    # Create new job
    job_counter += 1
    job_id = str(job_counter)
    
    print(f"[DEBUG] Creating job {job_id} for profile {profile_id}")
    print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
    
    # Check if job already exists (shouldn't happen, but just in case)
    if job_id in fetch_jobs:
        print(f"[DEBUG] WARNING: Job {job_id} already exists! Overwriting...")
    
    fetch_jobs[job_id] = {
        'id': job_id,
        'profile': profile_id,
        'status': 'queued',
        'created_time': datetime.now().isoformat(),
        'start_time': None,
        'end_time': None,
        'return_code': None,
        'output': None,
        'error': None
    }
    
    print(f"[DEBUG] Job {job_id} created successfully")
    print(f"[DEBUG] Updated fetch_jobs keys: {list(fetch_jobs.keys())}")
    
    # Add periodic job existence check
    def check_job_exists():
        if job_id in fetch_jobs:
            print(f"[DEBUG] Job {job_id} still exists in fetch_jobs")
        else:
            print(f"[DEBUG] WARNING: Job {job_id} missing from fetch_jobs!")
            print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
    
    # Check job existence after a short delay
    import threading
    def delayed_check():
        import time
        time.sleep(2)
        check_job_exists()
    
    # Add periodic monitoring to track when job disappears
    def monitor_job():
        import time
        for i in range(30):  # Monitor for 30 seconds
            time.sleep(1)
            if job_id not in fetch_jobs:
                print(f"[DEBUG] MONITOR: Job {job_id} disappeared after {i+1} seconds!")
                print(f"[DEBUG] MONITOR: Current fetch_jobs keys: {list(fetch_jobs.keys())}")
                break
            else:
                print(f"[DEBUG] MONITOR: Job {job_id} still exists after {i+1} seconds")
    
    threading.Thread(target=delayed_check, daemon=True).start()
    threading.Thread(target=monitor_job, daemon=True).start()
    
    # Start background thread
    thread = threading.Thread(target=run_fetch_script, args=(profile_id, job_id))
    thread.daemon = False  # Changed from True to False to prevent premature cleanup
    thread.start()
    
    return jsonify({
        'job_id': job_id,
        'status': 'queued',
        'message': 'Fetch operation started'
    })

@app.route('/api/fetch-status/<job_id>')
def fetch_status(job_id):
    """Get status of a fetch operation"""
    # Check if fetch_jobs has been reassigned
    check_fetch_jobs_reassignment()
    
    print(f"[DEBUG] Fetch status requested for job {job_id}")
    print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
    print(f"[DEBUG] Job {job_id} in fetch_jobs: {job_id in fetch_jobs}")
    
    if job_id not in fetch_jobs:
        print(f"[DEBUG] Job {job_id} not found in fetch_jobs. Available jobs: {list(fetch_jobs.keys())}")
        # Check if there are any jobs at all
        if not fetch_jobs:
            print(f"[DEBUG] fetch_jobs is completely empty!")
        return jsonify({'error': 'Job not found'}), 404
    
    job = fetch_jobs[job_id]
    print(f"[DEBUG] Job {job_id} status: {job.get('status', 'unknown')}, throttle_active: {job.get('throttle_active', False)}")
    return jsonify(job)

@app.route('/api/fetch-jobs')
def list_fetch_jobs():
    """List all fetch jobs"""
    return jsonify(list(fetch_jobs.values()))

@app.route('/api/cancel-fetch/<job_id>', methods=['POST'])
def cancel_fetch(job_id):
    """Cancel a running fetch operation"""
    print(f"[DEBUG] Cancel request for job {job_id}")
    print(f"[DEBUG] Current fetch_jobs keys: {list(fetch_jobs.keys())}")
    
    if job_id not in fetch_jobs:
        print(f"[DEBUG] Job {job_id} not found for cancellation")
        return jsonify({'error': 'Job not found'}), 404
    
    job = fetch_jobs[job_id]
    print(f"[DEBUG] Job {job_id} status: {job.get('status', 'unknown')}")
    
    if job['status'] not in ('queued', 'running'):
        print(f"[DEBUG] Job {job_id} cannot be cancelled (status: {job['status']})")
        return jsonify({'error': 'Job cannot be cancelled'}), 400
    
    try:
        # Terminate the subprocess if it exists
        proc = fetch_procs.get(job_id)
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                # Give it a moment to exit gracefully
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
            except Exception as e:
                print(f"Warning: failed to terminate fetch job {job_id}: {e}")
        
        # Mark job as cancelled
        fetch_jobs[job_id]['status'] = 'cancelled'
        fetch_jobs[job_id]['end_time'] = datetime.now().isoformat()
        fetch_jobs[job_id]['error'] = 'Cancelled by user'
        
        print(f"[DEBUG] Job {job_id} marked as cancelled")
        print(f"[DEBUG] Updated fetch_jobs keys: {list(fetch_jobs.keys())}")
        
        return jsonify({
            'success': True,
            'message': 'Fetch operation cancelled'
        })
        
    except Exception as e:
        return jsonify({'error': f'Failed to cancel job: {str(e)}'}), 500

@app.route('/api/fetch-logging', methods=['GET', 'POST'])
def fetch_logging():
    """Get or set verbose fetch logging status"""
    global VERBOSE_FETCH_LOGGING
    
    if request.method == 'GET':
        return jsonify({
            'verbose_logging': VERBOSE_FETCH_LOGGING,
            'message': 'Verbose fetch logging is ' + ('enabled' if VERBOSE_FETCH_LOGGING else 'disabled')
        })
    
    elif request.method == 'POST':
        data = request.get_json() or {}
        enabled = data.get('enabled', True)
        VERBOSE_FETCH_LOGGING = bool(enabled)
        
        return jsonify({
            'success': True,
            'verbose_logging': VERBOSE_FETCH_LOGGING,
            'message': 'Verbose fetch logging ' + ('enabled' if VERBOSE_FETCH_LOGGING else 'disabled')
        })

@app.route('/api/profiles')
def list_profiles():
    """List available profiles with creation dates"""
    profiles = []
    profiles_dir = 'profiles'
    
    if os.path.exists(profiles_dir):
        for entry in os.listdir(profiles_dir):
            profile_path = os.path.join(profiles_dir, entry)
            if os.path.isdir(profile_path) and os.path.exists(os.path.join(profile_path, 'auth', 'tokens.json')):
                # Try to get creation date from client.json
                client_file = os.path.join(profile_path, 'auth', 'client.json')
                creation_date = 'Unknown'
                
                if os.path.exists(client_file):
                    try:
                        with open(client_file, 'r') as f:
                            client_data = json.load(f)
                            if 'created_at' in client_data:
                                # Parse ISO format and format for display
                                created_dt = datetime.fromisoformat(client_data['created_at'])
                                creation_date = created_dt.strftime('%Y-%m-%d %H:%M')
                    except Exception as e:
                        print(f"Error reading creation date for {entry}: {e}")
                
                profiles.append({
                    'name': entry,
                    'created': creation_date
                })
    
    # Sort by profile name
    profiles.sort(key=lambda x: x['name'])
    return jsonify(profiles)

@app.route('/api/health')
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'active_jobs': len([j for j in fetch_jobs.values() if j['status'] == 'running'])
    })

def run_authorize_script(profile_id, job_id):
    """Run authorize_fitbit.py in background thread to complete OAuth flow"""
    try:
        auth_jobs[job_id]['status'] = 'running'
        auth_jobs[job_id]['start_time'] = datetime.now().isoformat()

        # Ensure profile directory exists (created during create-profile)
        profile_dir = f'profiles/{profile_id}'
        if not os.path.exists(profile_dir):
            auth_jobs[job_id]['status'] = 'failed'
            auth_jobs[job_id]['end_time'] = datetime.now().isoformat()
            auth_jobs[job_id]['error'] = f'Profile {profile_id} not found. Create it first.'
            return

        # Run the authorization script (opens browser locally and saves tokens)
        cmd = ['python', 'auth/authorize_fitbit.py', '--profile', profile_id]
        result = subprocess.run(
            cmd,
            cwd=os.getcwd(),
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=900  # 15 minutes to allow user interaction
        )

        auth_jobs[job_id]['status'] = 'completed' if result.returncode == 0 else 'failed'
        auth_jobs[job_id]['end_time'] = datetime.now().isoformat()
        auth_jobs[job_id]['return_code'] = result.returncode
        auth_jobs[job_id]['output'] = result.stdout
        auth_jobs[job_id]['error'] = result.stderr
    except subprocess.TimeoutExpired:
        auth_jobs[job_id]['status'] = 'timeout'
        auth_jobs[job_id]['end_time'] = datetime.now().isoformat()
        auth_jobs[job_id]['error'] = 'Authorization timed out after 15 minutes'
    except Exception as e:
        auth_jobs[job_id]['status'] = 'error'
        auth_jobs[job_id]['end_time'] = datetime.now().isoformat()
        auth_jobs[job_id]['error'] = str(e)

@app.route('/api/authorize/<profile_id>', methods=['GET', 'POST'])
def start_authorization(profile_id):
    """
    GET: Return recommended mode and authorization URL.
         If HTTPS localhost redirect is configured but cert/key are missing, return manual mode with URL.
    POST: Start background authorization job that opens a browser and captures the callback automatically.
    """
    try:
        import sys
        sys.path.append('auth')
        from authorize_fitbit import REDIRECT_URI as DEFAULT_REDIRECT_URI  # type: ignore
        from authorize_fitbit import exchange_code_for_token  # noqa: F401 (used by other endpoint)

        # Determine redirect URI and whether HTTPS localhost is usable
        redirect_uri = os.getenv('FITBIT_REDIRECT_URI', DEFAULT_REDIRECT_URI).strip()
        needs_https_local = redirect_uri.startswith('https://localhost:') or redirect_uri.startswith('https://127.0.0.1:')
        cert = os.getenv('FITBIT_SSL_CERT', '').strip()
        key = os.getenv('FITBIT_SSL_KEY', '').strip()
        has_https_creds = bool(cert and key and os.path.exists(cert) and os.path.exists(key))

        # Load client_id for auth URL
        client_file = os.path.join('profiles', profile_id, 'auth', 'client.json')
        if not os.path.exists(client_file):
            return jsonify({'error': f'Client credentials not found for profile {profile_id}'}), 400
        with open(client_file, 'r', encoding='utf-8') as f:
            client_json = json.load(f)
        client_id = client_json.get('client_id', '').strip()
        if not client_id:
            return jsonify({'error': 'Client ID missing in client.json'}), 400

        # Build authorization URL
        from urllib.parse import urlencode
        params = {
            'client_id': client_id,
            'response_type': 'code',
            'scope': 'heartrate sleep activity profile',
            'redirect_uri': redirect_uri,
        }
        auth_url = f"https://www.fitbit.com/oauth2/authorize?{urlencode(params)}"

        if request.method == 'GET':
            if needs_https_local and not has_https_creds:
                return jsonify({
                    'mode': 'manual',
                    'auth_url': auth_url,
                    'redirect_uri': redirect_uri,
                    'message': 'HTTPS localhost redirect without certs: use manual flow.'
                })
            return jsonify({
                'mode': 'background',
                'auth_url': auth_url,
                'redirect_uri': redirect_uri,
                'message': 'Background authorization supported.'
            })

        # POST: start background job
        global auth_job_counter
        auth_job_counter += 1
        job_id = str(auth_job_counter)

        auth_jobs[job_id] = {
            'id': job_id,
            'profile': profile_id,
            'status': 'queued',
            'created_time': datetime.now().isoformat(),
            'start_time': None,
            'end_time': None,
            'return_code': None,
            'output': None,
            'error': None
        }

        thread = threading.Thread(target=run_authorize_script, args=(profile_id, job_id))
        thread.daemon = False  # Changed from True to False to prevent premature cleanup
        thread.start()

        return jsonify({
            'job_id': job_id,
            'status': 'queued',
            'message': f'Authorization started for profile: {profile_id}'
        })
    except Exception as e:
        return jsonify({'error': f'Failed to start or query authorization: {str(e)}'}), 500

@app.route('/api/authorize-status/<job_id>')
def authorize_status(job_id):
    """Get status of an authorization operation"""
    if job_id not in auth_jobs:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify(auth_jobs[job_id])

@app.route('/api/authorize-exchange', methods=['POST'])
def authorize_exchange():
    """Exchange a pasted redirect URL or code for tokens (manual flow)"""
    try:
        data = request.get_json() or {}
        profile_name = (data.get('profileName') or '').strip()
        pasted_url = (data.get('redirectUrl') or '').strip()
        pasted_code = (data.get('code') or '').strip()

        if not profile_name:
            return jsonify({'error': 'Profile name is required'}), 400

        import sys
        sys.path.append('auth')
        from authorize_fitbit import (
            extract_code_from_url,
            exchange_code_for_token,
            client_credentials_file_for,
            get_active_profile,
            REDIRECT_URI as DEFAULT_REDIRECT_URI,
        )

        # Determine code
        code = pasted_code
        if not code:
            code = extract_code_from_url(pasted_url) or ''
        code = code.strip()
        if not code:
            return jsonify({'error': 'Authorization code not found. Paste the full redirected URL or the code.'}), 400

        # Load client credentials
        cred_path = os.path.join('profiles', profile_name, 'auth', 'client.json')
        if not os.path.exists(cred_path):
            return jsonify({'error': 'Client credentials file not found for this profile'}), 400
        with open(cred_path, 'r', encoding='utf-8') as f:
            cj = json.load(f)
        client_id = (cj.get('client_id') or '').strip()
        client_secret = (cj.get('client_secret') or '').strip()
        if not client_id or not client_secret:
            return jsonify({'error': 'Client credentials are incomplete'}), 400

        redirect_uri = os.getenv('FITBIT_REDIRECT_URI', DEFAULT_REDIRECT_URI).strip()

        # Exchange and save tokens
        ok = exchange_code_for_token(code, redirect_uri, client_id, client_secret, profile_id=profile_name)
        if ok:
            return jsonify({'message': 'Authorization complete and tokens saved.'})
        return jsonify({'error': 'Token exchange failed'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to exchange code: {str(e)}'}), 500

@app.route('/api/save-avatar', methods=['POST'])
def save_avatar():
    """Save avatar image data for a profile"""
    try:
        data = request.get_json() or {}
        profile_name = (data.get('profileName') or '').strip()
        avatar_data = data.get('avatarData', '').strip()
        
        if not profile_name:
            return jsonify({'error': 'Profile name is required'}), 400
        
        if not avatar_data:
            return jsonify({'error': 'Avatar data is required'}), 400
        
        # Validate profile exists
        profile_dir = f'profiles/{profile_name}'
        if not os.path.exists(profile_dir):
            return jsonify({'error': f'Profile "{profile_name}" not found'}), 404
        
        # Validate avatar data format (should be data:image/...;base64,...)
        if not avatar_data.startswith('data:image/'):
            return jsonify({'error': 'Invalid avatar data format'}), 400
        
        # Extract MIME type and base64 data
        try:
            header, base64_data = avatar_data.split(',', 1)
            mime_type = header.split(':')[1].split(';')[0]
            
            # Validate MIME type
            if not mime_type.startswith('image/'):
                return jsonify({'error': 'File must be an image'}), 400
                
        except (ValueError, IndexError):
            return jsonify({'error': 'Invalid avatar data format'}), 400
        
        # Calculate file size (base64 is ~33% larger than binary)
        import base64
        try:
            decoded_size = len(base64.b64decode(base64_data))
            if decoded_size > 5 * 1024 * 1024:  # 5MB limit
                return jsonify({'error': 'Image file is too large. Please select an image smaller than 5MB.'}), 400
        except Exception:
            return jsonify({'error': 'Invalid base64 data'}), 400
        
        # Create avatar data structure
        avatar_info = {
            'avatar_data': avatar_data,
            'uploaded_at': datetime.now().isoformat(),
            'file_size': decoded_size,
            'mime_type': mime_type
        }
        
        # Save to profile directory
        avatar_file = os.path.join(profile_dir, 'avatar.json')
        with open(avatar_file, 'w', encoding='utf-8') as f:
            json.dump(avatar_info, f, indent=2)
        
        print(f"Saved avatar for profile: {profile_name}")
        return jsonify({
            'message': f'Avatar saved successfully for profile "{profile_name}"',
            'profileName': profile_name,
            'fileSize': decoded_size,
            'mimeType': mime_type
        })
        
    except PermissionError as e:
        print(f"Error saving avatar (permissions): {e}")
        return jsonify({
            'error': 'Failed to save avatar: permission denied',
            'hint': (
                "Ensure the 'profiles' directory is writable. On Docker/Linux: "
                "`sudo chown -R 10001:10001 profiles` or set `user: \"${UID:-10001}:${GID:-10001}\"` in docker-compose.yml."
            )
        }), 500
    except Exception as e:
        print(f"Error saving avatar: {e}")
        return jsonify({'error': f'Failed to save avatar: {str(e)}'}), 500

@app.route('/api/get-avatar/<profile_name>')
def get_avatar(profile_name):
    """Get avatar image data for a profile"""
    try:
        # Validate profile name
        import re
        if not re.match(r'^[a-zA-Z0-9_-]+$', profile_name):
            return jsonify({'error': 'Invalid profile name format'}), 400
        
        # Check if profile exists
        profile_dir = f'profiles/{profile_name}'
        if not os.path.exists(profile_dir):
            return jsonify({'error': f'Profile "{profile_name}" not found'}), 404
        
        # Look for avatar file
        avatar_file = os.path.join(profile_dir, 'avatar.json')
        if not os.path.exists(avatar_file):
            return jsonify({'error': 'No avatar found for this profile'}), 404
        
        # Read avatar data
        with open(avatar_file, 'r', encoding='utf-8') as f:
            avatar_info = json.load(f)
        
        # Validate avatar data structure
        if 'avatar_data' not in avatar_info:
            return jsonify({'error': 'Invalid avatar data format'}), 500
        
        return jsonify({
            'avatar': avatar_info['avatar_data'],
            'uploaded_at': avatar_info.get('uploaded_at'),
            'file_size': avatar_info.get('file_size'),
            'mime_type': avatar_info.get('mime_type')
        })
        
    except json.JSONDecodeError:
        return jsonify({'error': 'Corrupted avatar data'}), 500
    except Exception as e:
        print(f"Error loading avatar for {profile_name}: {e}")
        return jsonify({'error': f'Failed to load avatar: {str(e)}'}), 500

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return "Resource not found", 404

@app.errorhandler(500)
def internal_error(error):
    return "Internal server error", 500

if __name__ == '__main__':
    print("Starting FitBaus Flask Server...")
    # Determine port (default to 9000; can override via env)
    port_str = os.getenv('PORT') or os.getenv('FITBAUS_PORT') or '9000'
    try:
        port = int(port_str)
    except Exception:
        port = 9000

    print(f"Server will be available at: http://localhost:{port}")
    print(f"API endpoints available at: http://localhost:{port}/api/")

    # Run the Flask app
    app.run(host='0.0.0.0', port=port, debug=False)
