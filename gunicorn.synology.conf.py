# Gunicorn configuration optimized for Synology NAS
import multiprocessing
import os

# Server socket
_port = os.getenv("PORT", "9000")
try:
    _port_int = int(_port)
except ValueError:
    _port_int = 9000
bind = f"0.0.0.0:{_port_int}"
backlog = 512  # Reduced for NAS

# Worker processes - optimized for NAS
workers = int(os.getenv("WORKERS", "1"))  # Single worker for NAS efficiency
worker_class = "sync"
worker_connections = 500  # Reduced for NAS
timeout = 120  # Reduced timeout for NAS
keepalive = 2

# Restart workers more frequently to prevent memory leaks
max_requests = 500  # Reduced for NAS
max_requests_jitter = 50

# Preload app for better performance
preload_app = True

# Logging optimized for Synology
accesslog = "/app/logs/access.log"
errorlog = "/app/logs/error.log"
loglevel = os.getenv("LOG_LEVEL", "info")
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

# Process naming
proc_name = "fitbaus-nas"

# Security limits
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

# Environment
raw_env = [
    "PYTHONIOENCODING=utf-8",
    "PYTHONUNBUFFERED=1",
]

# Memory optimization for NAS
worker_tmp_dir = "/tmp"
