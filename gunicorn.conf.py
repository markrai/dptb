# Gunicorn configuration for production
import multiprocessing
import os

# Server socket
# Allow overriding port via PORT env var (defaults to 9156)
_port = os.getenv("PORT", "9156")
try:
    _port_int = int(_port)
except ValueError:
    _port_int = 9156
bind = f"0.0.0.0:{_port_int}"
backlog = 2048

# Worker processes
workers = min(2, multiprocessing.cpu_count() * 2 + 1)
worker_class = "sync"
worker_connections = 1000
timeout = 300
keepalive = 2

# Restart workers after this many requests, to prevent memory leaks
max_requests = 1000
max_requests_jitter = 100

# Preload app for better performance
preload_app = True

# Logging
accesslog = "-"
errorlog = "-"
loglevel = "info"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

# Process naming
proc_name = "fitbaus"

# Security
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

# Environment
raw_env = [
    "PYTHONIOENCODING=utf-8",
]
