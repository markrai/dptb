# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
RUN useradd -m -u 10001 app
COPY --chown=10001:10001 requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY --chown=10001:10001 . .

# Ensure the working directory is writable by the app user
RUN chown 10001:10001 /app

# Switch to non-root user and create necessary directories
USER app
RUN mkdir -p profiles auth

# Expose port for the web server
EXPOSE 9156
# Optional: local HTTPS callback for background OAuth (uncomment compose mapping)
EXPOSE 8080

# Healthcheck for self-host monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD /bin/sh -c "curl -fsS http://localhost:${PORT:-9156}/api/health || exit 1"

# Default command (start with Gunicorn production server)
CMD ["gunicorn", "--config", "gunicorn.conf.py", "server:app"]
