#!/usr/bin/env python3
"""
Reset script for FitBaus application.

This script safely deletes user data and generated files to return the
application to a clean state with no users and no data.

Behavior:
- Cleans the contents of the profiles/ directory (but keeps the folder itself)
- Removes legacy auth files and legacy csv directory if present
- Removes token backup files (*.bak)

The script preserves:
- The profiles/ directory (so it remains present for mounting/bind purposes)
- All application code and configuration files.
"""

import os
import sys
import shutil
import glob
import argparse
from pathlib import Path


def print_status(message, status="INFO"):
    """Print a status message with safe Unicode handling."""
    try:
        print(message)
    except UnicodeEncodeError:
        # Fallback to ASCII-safe characters for Windows console
        safe_message = message.replace('WARNING:', '[WARNING]').replace('ERROR:Œ', '[ERROR]').replace('SUCCESS:…', '[SUCCESS]')
        print(safe_message)


def safe_remove_path(path, description):
    """Safely remove a file or directory if it exists."""
    if os.path.exists(path):
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
                print_status(f"Removed directory: {path}", "SUCCESS")
            else:
                os.remove(path)
                print_status(f"Removed file: {path}", "SUCCESS")
            return True
        except Exception as e:
            print_status(f"Failed to remove {description}: {e}", "ERROR")
            return False
    else:
        print_status(f"{description} not found (already clean)", "INFO")
        return True


def clean_directory_contents(dir_path: str, preserve_names: list[str] | None = None) -> bool:
    """Remove all files and subdirectories inside dir_path, preserving dir_path itself.

    Returns True if all deletions succeeded (or nothing to delete), False otherwise.
    """
    preserve = set(preserve_names or [])
    if not os.path.exists(dir_path):
        try:
            os.makedirs(dir_path, exist_ok=True)
            return True
        except Exception as e:
            print_status(f"Failed to create directory {dir_path}: {e}", "ERROR")
            return False

    ok = True
    try:
        for entry in os.listdir(dir_path):
            if entry in preserve:
                continue
            full = os.path.join(dir_path, entry)
            try:
                if os.path.isdir(full) and not os.path.islink(full):
                    shutil.rmtree(full)
                    print_status(f"Removed directory: {full}", "SUCCESS")
                else:
                    os.remove(full)
                    print_status(f"Removed file: {full}", "SUCCESS")
            except Exception as e:
                ok = False
                print_status(f"Failed to remove {full}: {e}", "ERROR")
    except Exception as e:
        ok = False
        print_status(f"Failed to list {dir_path}: {e}", "ERROR")
    return ok


def show_usage():
    """Display usage information and examples."""
    print_status("DESCRIPTION:", "INFO")
    print_status("  This script safely deletes user data, profiles, and generated files", "INFO")
    print_status("  to return the FitBaus application to a clean state.", "INFO")
    print()
    print_status("USAGE:", "INFO")
    print_status("  python reset.py                    # Delete ALL profiles and data", "INFO")
    print_status("  python reset.py --profile <name>   # Delete specific profile only", "INFO")
    print()
    print_status("EXAMPLES:", "INFO")
    print_status("  python reset.py --profile john     # Delete only the 'john' profile", "INFO")
    print_status("  python reset.py --profile jane     # Delete only the 'jane' profile", "INFO")
    print_status("  python reset.py                    # Delete everything (full reset)", "INFO")
    print()
    print_status("WHAT GETS DELETED (FULL RESET):", "WARNING")
    print_status("    • profiles/ directory (all user profiles and data)", "WARNING")
    print_status("    • auth/tokens.json (legacy authentication tokens)", "WARNING")
    print_status("    • auth/client.json (legacy client credentials)", "WARNING")
    print_status("    • csv/ directory (legacy CSV data files)", "WARNING")
    print_status("    • Any token backup files (*.bak)", "WARNING")
    print()
    print_status("WHAT GETS DELETED (PROFILE-SPECIFIC):", "WARNING")
    print_status("    • profiles/<name>/ directory (specific profile and data)", "WARNING")
    print_status("    • profiles/<name>/auth/ (authentication tokens and credentials)", "WARNING")
    print_status("    • profiles/<name>/csv/ (CSV data files for that profile)", "WARNING")
    print_status("    • Any token backup files for that profile", "WARNING")
    print()
    print_status("WHAT GETS PRESERVED:", "SUCCESS")
    print_status("    • All application code (auth/, common/, fetch/, generate/)", "SUCCESS")
    print_status("    • Configuration files (requirements.txt, Dockerfile, etc.)", "SUCCESS")
    print_status("    • Web interface files (index.html, script.js, style.css)", "SUCCESS")
    print_status("    • Documentation and assets", "SUCCESS")
    print_status("    • Other profiles (when using --profile)", "SUCCESS")
    print()
    print_status("=" * 60, "INFO")


def get_user_confirmation(is_profile_specific=False, profile_name=None):
    """Get user confirmation before proceeding with the reset."""
    if is_profile_specific:
        print_status(f"WARNING:  WARNING: This will permanently delete profile '{profile_name}' and all its data!", "WARNING")
        print()
        print_status("This includes:", "WARNING")
        print_status(f"    • Profile '{profile_name}' directory and all contents", "WARNING")
        print_status(f"    • Authentication tokens for '{profile_name}'", "WARNING")
        print_status(f"    • Client credentials for '{profile_name}'", "WARNING")
        print_status(f"    • All CSV data files for '{profile_name}'", "WARNING")
        print_status(f"    • Any backup files for '{profile_name}'", "WARNING")
        print()
        print_status("Other profiles will be preserved.", "SUCCESS")
    else:
        print_status("WARNING:  WARNING: This will permanently delete ALL user data!", "WARNING")
        print()
        print_status("This includes:", "WARNING")
        print_status("    • All user profiles and authentication tokens", "WARNING")
        print_status("    • All CSV data files (HRV, RHR, sleep, steps)", "WARNING")
        print_status("    • All user-specific configuration files", "WARNING")
    
    print()
    print_status("This action CANNOT be undone!", "ERROR")
    print()
    
    while True:
        response = input("Are you sure you want to proceed? Type 'yes' to continue or 'no' to cancel: ").strip().lower()
        if response in ['yes', 'y']:
            return True
        elif response in ['no', 'n']:
            return False
        else:
            print_status("Please type 'yes' or 'no'", "WARNING")


def delete_specific_profile(profile_name, skip_confirmation=False):
    """Delete a specific profile and all its data."""
    profile_path = f"profiles/{profile_name}"
    
    if not os.path.exists(profile_path):
        print_status(f"ERROR: Profile '{profile_name}' not found.", "ERROR")
        print_status(f"Available profiles:", "INFO")
        
        # List available profiles
        if os.path.exists("profiles"):
            profiles = [d for d in os.listdir("profiles") if os.path.isdir(f"profiles/{d}") and d != "index.json"]
            if profiles:
                for profile in profiles:
                    print_status(f"    • {profile}", "INFO")
            else:
                print_status("  No profiles found", "INFO")
        else:
            print_status("  No profiles directory found", "INFO")
        
        return False
    
    print_status("=" * 60, "INFO")
    print_status(f"FitBaus Profile Deletion: {profile_name}", "INFO")
    print_status("=" * 60, "INFO")
    print()
    
    # Get user confirmation (skip if non-interactive mode)
    if not skip_confirmation:
        if not get_user_confirmation(is_profile_specific=True, profile_name=profile_name):
            print_status("Profile deletion cancelled.", "WARNING")
            return False
    else:
        print_status(f"Deleting profile '{profile_name}' in non-interactive mode...", "INFO")
    
    print()
    print_status("Starting profile deletion...", "INFO")
    
    # Track overall success
    all_success = True
    
    # 1. Remove the specific profile directory
    print_status(f"1. Removing profile '{profile_name}' directory...", "INFO")
    if not safe_remove_path(profile_path, f"profile '{profile_name}' directory"):
        all_success = False
    
    # 2. Remove profile-specific backup files
    print_status(f"2. Removing backup files for profile '{profile_name}'...", "INFO")
    backup_patterns = [
        f"profiles/{profile_name}/auth/tokens.json.bak"
    ]
    
    backup_files_found = 0
    for pattern in backup_patterns:
        for backup_file in glob.glob(pattern):
            if os.path.exists(backup_file):
                backup_files_found += 1
                if not safe_remove_path(backup_file, f"backup file {backup_file}"):
                    all_success = False
    
    if backup_files_found == 0:
        print_status("No backup files found for this profile", "INFO")
    
    # 3. Verify profile deletion
    print_status(f"3. Verifying profile '{profile_name}' deletion...", "INFO")
    if os.path.exists(profile_path):
        print_status(f"Warning: Profile '{profile_name}' directory still exists", "WARNING")
        all_success = False
    else:
        print_status(f"Profile '{profile_name}' successfully deleted", "SUCCESS")
    
    # Summary
    print_status("\n" + "=" * 60, "INFO")
    if all_success:
        print_status(f"SUCCESS:… Profile '{profile_name}' deleted successfully!", "SUCCESS")
        print_status("The profile and all its data have been removed.", "SUCCESS")
        print_status("Other profiles remain unaffected.", "SUCCESS")
    else:
        print_status(f"ERROR:Œ Profile deletion completed with errors.", "ERROR")
        print_status("Some files could not be removed. Check the errors above.", "ERROR")
        return False
    
    print_status("=" * 60, "INFO")
    return True


def main():
    """Main reset function."""
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Reset FitBaus application data")
    parser.add_argument("--profile", help="Delete specific profile only (instead of all data)")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompts (non-interactive mode)")
    args = parser.parse_args()
    
    # If profile specified, delete only that profile
    if args.profile:
        return delete_specific_profile(args.profile, skip_confirmation=args.yes)
    
    # Otherwise, show usage if any other arguments provided
    if len(sys.argv) > 1:
        show_usage()
        return
    
    print_status("=" * 60, "INFO")
    print_status("FitBaus Reset Script", "INFO")
    print_status("=" * 60, "INFO")
    print()
    
    # Get the script directory (root of the project)
    script_dir = Path(__file__).parent.absolute()
    os.chdir(script_dir)
    
    print_status(f"Working directory: {script_dir}", "INFO")
    print()
    
    # Get user confirmation before proceeding
    if not get_user_confirmation(is_profile_specific=False):
        print_status("Reset cancelled by user.", "INFO")
        return
    
    print()
    print_status("Proceeding with reset...", "INFO")
    print()
    
    # Track overall success
    all_success = True
    
    # 1. Remove entire profiles directory
    print_status("1. Cleaning user profiles directory contents...", "INFO")
    profiles_path = "profiles"
    # Preserve a repo placeholder file if present
    if not clean_directory_contents(profiles_path, preserve_names=[".gitkeep"]):
        all_success = False
    
    # 2. Remove legacy auth files (for backward compatibility)
    print_status("\n2. Removing legacy auth files...", "INFO")
    legacy_auth_files = [
        ("auth/tokens.json", "legacy tokens file"),
        ("auth/client.json", "legacy client credentials file")
    ]
    
    for file_path, description in legacy_auth_files:
        if not safe_remove_path(file_path, description):
            all_success = False
    
    # 3. Remove legacy CSV directory (for backward compatibility)
    print_status("\n3. Removing legacy CSV data directory...", "INFO")
    csv_path = "csv"
    if not safe_remove_path(csv_path, "legacy CSV directory"):
        all_success = False
    
    # 4. Remove token backup files
    print_status("\n4. Removing token backup files...", "INFO")
    backup_patterns = [
        "auth/tokens.json.bak",
        "profiles/*/auth/tokens.json.bak"
    ]
    
    backup_files_found = 0
    for pattern in backup_patterns:
        for backup_file in glob.glob(pattern):
            if os.path.exists(backup_file):
                backup_files_found += 1
                if not safe_remove_path(backup_file, f"backup file {backup_file}"):
                    all_success = False
    
    if backup_files_found == 0:
        print_status("No token backup files found", "INFO")
    
    # 5. Verify clean state
    print_status("\n5. Verifying clean state...", "INFO")
    verification_paths = [
        ("profiles", "profiles directory should be empty (except .gitkeep)"),
        ("auth/tokens.json", "legacy tokens file"),
        ("auth/client.json", "legacy client credentials file"),
        ("csv", "legacy CSV directory")
    ]

    clean_state = True
    for path, description in verification_paths:
        if path == "profiles":
            if not os.path.exists(path):
                print_status("Warning: profiles directory is missing", "WARNING")
                clean_state = False
            else:
                remaining = [e for e in os.listdir(path) if e != ".gitkeep"]
                if remaining:
                    print_status(f"Warning: profiles directory not empty (remaining: {', '.join(remaining)})", "WARNING")
                    clean_state = False
        else:
            if os.path.exists(path):
                print_status(f"Warning: {description} still exists", "WARNING")
                clean_state = False
    
    # Summary
    print_status("\n" + "=" * 60, "INFO")
    if all_success and clean_state:
        print_status("SUCCESS:… Reset completed successfully!", "SUCCESS")
        print_status("The application is now in a clean state with no users or data.", "SUCCESS")
        print_status("You can now run the authentication process to create new profiles.", "INFO")
    elif all_success:
        print_status("Reset completed with warnings.", "WARNING")
        print_status("Some files may still exist. Check the warnings above.", "WARNING")
    else:
        print_status("ERROR: Reset completed with errors.", "ERROR")
        print_status("Some files could not be removed. Check the errors above.", "ERROR")
        sys.exit(1)
    
    print_status("=" * 60, "INFO")


if __name__ == "__main__":
    # Set up environment for proper Unicode handling
    import os
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    
    try:
        main()
    except KeyboardInterrupt:
        print_status("\n\nERROR: Reset cancelled by user.", "WARNING")
        sys.exit(1)
    except Exception as e:
        print_status(f"\nERROR: Unexpected error during reset: {e}", "ERROR")
        sys.exit(1)