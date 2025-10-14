#!/usr/bin/env python3
"""
Deploy script for FitBaus
Copies project files to public directory, obfuscates JavaScript, and cleans up
"""

import os
import shutil
import subprocess
import sys
import fnmatch
from pathlib import Path

# Source and destination directories
SOURCE_DIR = Path(r"c:\dev\project\fitbaus")
DEST_DIR = Path(r"c:\dev\project\fitbaus-public")

# Files to copy (exclude temporary files and deploy.py)
FILES_TO_COPY = [
    "index.html",
    "mobile.html",
    "spousal.html",
    "style.css", 
    "script.js",
    "version.js",
    "server.py",
    "requirements.txt",
    "Dockerfile",
    "docker-compose.yml",
    "gunicorn.conf.py",
    "fitbaus.jpg",
    "README.md",
    "reset.py"
]

# Directories to copy
DIRS_TO_COPY = [
    "assets",
    "auth",
    "common", 
    "fetch",
    "generate"
]

# Default exclude patterns (will be merged with .gitignore)
DEFAULT_EXCLUDE_PATTERNS = [
    "deploy.py",
    "deploy.bat",
    "profiles",
    "csv"
]

def read_gitignore():
    """Read .gitignore file and return list of patterns"""
    gitignore_path = SOURCE_DIR / ".gitignore"
    patterns = DEFAULT_EXCLUDE_PATTERNS.copy()
    
    if gitignore_path.exists():
        try:
            with open(gitignore_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    # Skip empty lines and comments
                    if line and not line.startswith('#'):
                        # Remove leading slash if present
                        if line.startswith('/'):
                            line = line[1:]
                        patterns.append(line)
            print(f"✓ Loaded {len(patterns) - len(DEFAULT_EXCLUDE_PATTERNS)} patterns from .gitignore")
        except Exception as e:
            print(f"Warning: Could not read .gitignore: {e}")
            print("Using default exclude patterns only")
    else:
        print("No .gitignore found, using default exclude patterns")
    
    return patterns

def should_exclude(file_path, exclude_patterns):
    """Check if a file should be excluded based on patterns"""
    file_name = file_path.name
    relative_path = file_path.relative_to(SOURCE_DIR)
    
    for pattern in exclude_patterns:
        # Check if pattern matches the file name
        if fnmatch.fnmatch(file_name, pattern):
            return True
        
        # Check if pattern matches the relative path
        if fnmatch.fnmatch(str(relative_path), pattern):
            return True
        
        # Check if pattern matches any part of the path
        for part in relative_path.parts:
            if fnmatch.fnmatch(part, pattern):
                return True
    
    return False

def copy_files():
    """Copy all relevant files to destination directory"""
    print(f"Copying files from {SOURCE_DIR} to {DEST_DIR}")
    
    # Read .gitignore patterns
    exclude_patterns = read_gitignore()
    
    # Create destination directory if it doesn't exist
    DEST_DIR.mkdir(parents=True, exist_ok=True)
    
    # Clear destination directory contents, preserving .git and .dockerignore
    if DEST_DIR.exists():
        print("Clearing destination directory (preserving .git and .dockerignore)...")
        try:
            for item in DEST_DIR.iterdir():
                if item.name in [".git", ".dockerignore"]:
                    continue
                try:
                    if item.is_file() or item.is_symlink():
                        try:
                            item.chmod(0o777)
                        except Exception:
                            pass
                        item.unlink()
                    elif item.is_dir():
                        shutil.rmtree(item, ignore_errors=True)
                except Exception as file_error:
                    print(f"Warning: Could not delete {item.name}: {file_error}")
            print("Directory cleanup completed (preserved .git and .dockerignore)")
        except Exception as e:
            print(f"Warning: Could not completely clear directory: {e}")
    
    # Copy individual files
    for file_name in FILES_TO_COPY:
        src_file = SOURCE_DIR / file_name
        dst_file = DEST_DIR / file_name
        
        if src_file.exists():
            if should_exclude(src_file, exclude_patterns):
                print(f"  Skipping {file_name} (excluded by .gitignore)")
            else:
                print(f"  Copying {file_name}")
                shutil.copy2(src_file, dst_file)
        else:
            print(f"  Warning: {file_name} not found in source")
    
    # Copy directories
    for dir_name in DIRS_TO_COPY:
        src_dir = SOURCE_DIR / dir_name
        dst_dir = DEST_DIR / dir_name
        
        if src_dir.exists() and src_dir.is_dir():
            if should_exclude(src_dir, exclude_patterns):
                print(f"  Skipping directory {dir_name} (excluded by .gitignore)")
            else:
                print(f"  Copying directory {dir_name}")
                if dst_dir.exists():
                    shutil.rmtree(dst_dir)
                # Exclude Python cache dirs/files
                shutil.copytree(
                    src_dir,
                    dst_dir,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo")
                )
        else:
            print(f"  Warning: Directory {dir_name} not found in source")

    # Ensure empty profiles directory is present in destination (copy only placeholder)
    profiles_src = SOURCE_DIR / "profiles"
    profiles_dst = DEST_DIR / "profiles"
    try:
        profiles_dst.mkdir(parents=True, exist_ok=True)
        placeholder = profiles_src / ".gitkeep"
        if placeholder.exists():
            shutil.copy2(placeholder, profiles_dst / ".gitkeep")
        print("  Ensured profiles directory exists in destination (no user data copied)")
    except Exception as e:
        print(f"  Warning: Could not prepare profiles directory in destination: {e}")

def obfuscate_javascript():
    """Obfuscate the JavaScript file"""
    print("\nObfuscating JavaScript...")
    
    # Change to destination directory
    os.chdir(DEST_DIR)
    print(f"Changed directory to {DEST_DIR}")
    
    # Check if script.js exists
    if not os.path.exists("script.js"):
        print("Error: script.js not found in destination directory")
        return False
    
    # Rename script.js to input.js
    print("Renaming script.js to input.js")
    os.rename("script.js", "input.js")
    
    # Check if input.js exists
    if not os.path.exists("input.js"):
        print("Error: input.js not found after renaming")
        return False
    
    print(f"input.js size: {os.path.getsize('input.js')} bytes")
    
    # Run obfuscation
    print("Running javascript-obfuscator...")

    def resolve_executable(candidates: list[str]) -> str | None:
        """Return the first resolvable executable path or command name.

        On Windows, npm global CLIs are commonly installed under
        %APPDATA%\\npm as .cmd shims. We'll probe multiple options.
        """
        import shutil as _sh

        for name in candidates:
            # Absolute path provided
            if os.path.isabs(name) and os.path.exists(name):
                return name
            # Try PATH lookup
            found = _sh.which(name)
            if found:
                return found
        return None

    # Build candidate lists for obfuscator and npx
    appdata = os.environ.get("APPDATA", "")
    npm_dir = os.path.join(appdata, "npm") if appdata else None
    obf_candidates: list[str] = [
        "javascript-obfuscator",
        "javascript-obfuscator.cmd",
    ]
    npx_candidates: list[str] = [
        "npx",
        "npx.cmd",
    ]
    if npm_dir:
        obf_candidates.insert(0, os.path.join(npm_dir, "javascript-obfuscator.cmd"))
        npx_candidates.insert(0, os.path.join(npm_dir, "npx.cmd"))

    obf_path = resolve_executable(obf_candidates)
    npx_path = resolve_executable(npx_candidates)

    # Try different command variations for obfuscation (prefer direct obfuscator)
    obfuscation_commands: list[list[str]] = []
    if obf_path:
        obfuscation_commands.append([obf_path, "input.js", "--output", "script.js"])
        # Also try via cmd /c in case PATHEXT resolution is needed
        obfuscation_commands.append(["cmd", "/c", obf_path, "input.js", "--output", "script.js"])
    else:
        # Fallback to PATH resolution through cmd
        obfuscation_commands.append(["cmd", "/c", "javascript-obfuscator", "input.js", "--output", "script.js"])

    if npx_path:
        obfuscation_commands.append([npx_path, "javascript-obfuscator", "input.js", "--output", "script.js"])
        obfuscation_commands.append(["cmd", "/c", npx_path, "javascript-obfuscator", "input.js", "--output", "script.js"])
    else:
        obfuscation_commands.append(["cmd", "/c", "npx", "javascript-obfuscator", "input.js", "--output", "script.js"])
    
    success = False
    for cmd in obfuscation_commands:
        try:
            print(f"Trying command: {' '.join(cmd)}")
            result = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=30)
            print("JavaScript obfuscation completed successfully")
            success = True
            break
        except subprocess.CalledProcessError as e:
            print(f"Command failed with exit code {e.returncode}: {' '.join(cmd)}")
            print(f"stdout: {e.stdout}")
            print(f"stderr: {e.stderr}")
            continue
        except FileNotFoundError as e:
            print(f"Command not found: {' '.join(cmd)}")
            print(f"Error: {e}")
            continue
        except subprocess.TimeoutExpired as e:
            print(f"Command timed out: {' '.join(cmd)}")
            continue
    
    if not success:
        print("All obfuscation commands failed. Please check your javascript-obfuscator installation.")
        return False
    
    # Delete input.js
    print("Deleting input.js")
    os.remove("input.js")
    
    return True


def main():
    """Main deployment function"""
    print("FitBaus Deployment Script")
    print("=" * 40)
    
    
    # Check if source directory exists
    if not SOURCE_DIR.exists():
        print(f"Error: Source directory {SOURCE_DIR} does not exist")
        sys.exit(1)
    
    # Check if script.js exists in source
    if not (SOURCE_DIR / "script.js").exists():
        print("Error: script.js not found in source directory")
        sys.exit(1)
    
    try:
        # Copy files
        copy_files()
        
        # Obfuscate JavaScript
        if not obfuscate_javascript():
            print("Deployment failed during JavaScript obfuscation")
            sys.exit(1)
        
        print("\n" + "=" * 40)
        print("Deployment completed successfully!")
        print(f"Files copied to: {DEST_DIR}")
        print("JavaScript has been obfuscated")
        
    except Exception as e:
        print(f"Error during deployment: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
