import os
from typing import Optional, List
import sys

# Compute repo root (folder containing 'common', 'auth', 'fetch', etc.)
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_active_profile(cli_profile: Optional[str] = None) -> Optional[str]:
    """Return the active profile id.

    Preference order:
    - Explicit CLI argument value if provided and non-empty
    - ENV var FITBIT_PROFILE if set and non-empty
    - Otherwise, None (meaning legacy default paths)
    """
    if cli_profile and str(cli_profile).strip():
        return str(cli_profile).strip()
    env_profile = os.getenv("FITBIT_PROFILE", "").strip()
    return env_profile or None


def tokens_file_for(profile_id: Optional[str]) -> str:
    """Absolute path to the tokens file for the profile.

    - None profile -> legacy path: ROOT/auth/tokens.json
    - Otherwise -> ROOT/profiles/<id>/auth/tokens.json
    """
    if not profile_id:
        return os.path.join(ROOT_DIR, "auth", "tokens.json")
    return os.path.join(ROOT_DIR, "profiles", profile_id, "auth", "tokens.json")


def csv_path_for(profile_id: Optional[str], filename: str) -> str:
    """Absolute path to a CSV file name for the profile.

    - None profile -> legacy path: ROOT/csv/<filename>
    - Otherwise -> ROOT/profiles/<id>/csv/<filename>
    """
    if not profile_id:
        return os.path.join(ROOT_DIR, "csv", filename)
    return os.path.join(ROOT_DIR, "profiles", profile_id, "csv", filename)


def list_profiles() -> List[str]:
    """Return a sorted list of available profile IDs (folder names under profiles/)."""
    profiles_dir = os.path.join(ROOT_DIR, "profiles")
    if not os.path.isdir(profiles_dir):
        return []
    ids = [name for name in os.listdir(profiles_dir)
           if os.path.isdir(os.path.join(profiles_dir, name))
           and not name.startswith('.')]
    return sorted(ids)


def resolve_or_prompt_profile(cli_profile: Optional[str] = None) -> str:
    """Resolve an active profile, prompting the user interactively if needed.

    Order of precedence:
    - Non-empty CLI value provided
    - ENV var FITBIT_PROFILE if set
    - If exactly one profile exists, use it
    - Otherwise, show an interactive prompt to choose from available profiles
    """
    # Prefer explicit CLI / ENV via existing helper
    selected = get_active_profile(cli_profile)
    if selected:
        return selected

    ids = list_profiles()
    if not ids:
        raise RuntimeError("No profiles found under 'profiles/'. Create one and try again.")
    if len(ids) == 1:
        return ids[0]

    # Interactive selection
    print("Select a profile:")
    for i, name in enumerate(ids, start=1):
        print(f"  {i}. {name}")

    if not sys.stdin.isatty():
        raise RuntimeError("No profile specified and no TTY available for interactive selection. Set FITBIT_PROFILE or pass --profile.")

    while True:
        choice = input(f"Enter number (1-{len(ids)}): ").strip()
        if choice.isdigit():
            idx = int(choice)
            if 1 <= idx <= len(ids):
                return ids[idx - 1]
        print("Invalid selection. Please try again.")


def ensure_dirs_for_tokens(path: str) -> None:
    """Ensure the parent directory for the tokens file exists."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)


def ensure_dirs_for_csv(path: str) -> None:
    """Ensure the parent directory for the csv file exists."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)


def client_credentials_file_for(profile_id: Optional[str]) -> str:
    """Absolute path to the client credentials file for the profile.

    - None profile -> legacy path: ROOT/auth/client.json
    - Otherwise -> ROOT/profiles/<id>/auth/client.json
    """
    if not profile_id:
        return os.path.join(ROOT_DIR, "auth", "client.json")
    return os.path.join(ROOT_DIR, "profiles", profile_id, "auth", "client.json")
