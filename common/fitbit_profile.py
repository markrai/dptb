import os
import json
from datetime import datetime
from typing import Optional

import requests

# Allow relative imports when executed from scripts in sibling folders
from common.profile_paths import tokens_file_for


def _load_access_token(tokens_path: str) -> Optional[str]:
    try:
        with open(tokens_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        token = data.get("access_token")
        if isinstance(token, str) and token.strip():
            return token.strip()
    except Exception:
        pass
    return None


def _ensure_env_for_profile(profile_id: Optional[str]) -> str:
    """Ensure env vars point to the correct profile token/credentials files.

    Returns the absolute path to the tokens file for the given profile.
    """
    tokens_path = tokens_file_for(profile_id)
    # Prefer explicit token path to avoid any ambiguity
    os.environ["FITBIT_TOKENS_FILE"] = tokens_path
    # Some helpers also consult FITBIT_PROFILE
    os.environ["FITBIT_PROFILE"] = (profile_id or "")
    return tokens_path


def get_member_since_date(profile_id: Optional[str]) -> Optional[datetime]:
    """Return the user's Fitbit "memberSince" date as a datetime, if available.

    Requires that the authorized token has the `profile` scope. If the scope is
    missing or the request fails, returns None so callers can fall back safely.
    """
    # Defer import to avoid circulars when auth.refresh_token imports this package's helpers
    from auth.refresh_token import refresh_token  # type: ignore

    tokens_path = _ensure_env_for_profile(profile_id)

    # Try with the current access token first to avoid unnecessary refreshes
    token = _load_access_token(tokens_path)
    url = "https://api.fitbit.com/1/user/-/profile.json"

    def _request(t: str):
        try:
            return requests.get(url, headers={"Authorization": f"Bearer {t}"}, timeout=30)
        except requests.RequestException:
            return None

    # Up to two attempts: current token, then refreshed token on 401
    attempts = 0
    last_status = None
    while attempts < 2:
        attempts += 1
        if not token:
            try:
                token = refresh_token()
            except Exception:
                token = None
        if not token:
            break
        res = _request(token)
        if res is None:
            break
        last_status = res.status_code
        if res.status_code == 200:
            try:
                data = res.json()
                # Expected shape: { "user": { "memberSince": "YYYY-MM-DD", ... } }
                ms = data.get("user", {}).get("memberSince")
                if isinstance(ms, str) and ms:
                    # Accept either YYYY-MM-DD or an ISO timestamp; take date-only part
                    date_part = ms.split("T")[0]
                    return datetime.strptime(date_part, "%Y-%m-%d")
            except Exception:
                return None
            return None
        if res.status_code in (401,):
            # Unauthorized — refresh and try once more
            try:
                token = refresh_token()
                continue
            except Exception:
                return None
        if res.status_code in (403,):
            # Forbidden — likely missing profile scope
            return None
        # Other statuses (429, 5xx, etc.) — do not block; caller will fall back
        return None

    # If we got here, we failed to obtain the profile
    return None
