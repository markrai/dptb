![Don't Poke the Bear!](assets/cleanlogo.png)

# Don't Poke the Bear!

A wellness monitoring app for couples that analyzes Fitbit data to calculate daily wellness scores and predict joint burnout.

## What does it do?

- Calculates individual daily wellness scores based on historical data
- Provides predictions on joint burnout risk
- Displays side-by-side health metrics for better awareness and motivation

## Features

- **Wellness Scoring**: Daily wellness calculations based on historical Fitbit data
- **Burnout Prediction**: Joint burnout risk (last 7 days of sleep quality, elevated RHR, and daily step counts)
- **Responsive Design**: Works on desktop and mobile devices
- **Real-time Data**: Fresh data indicators with color-coded status bullet

## Docker Deployment

The app is available as a Docker container:

```bash
docker pull markraidc/dont-poke-the-bear
```

**Docker Hub**: https://hub.docker.com/repository/docker/markraidc/dont-poke-the-bear/general

 
## Usage

1. Create profiles for both partners
2. Connect your Fitbit accounts
3. View daily wellness scores and burnout predictions
4. Monitor your joint health metrics


### Synology NAS Deployment

1) Prerequisites
- Install DSM "Container Manager" (Package Center).
- (Recommended) Install Portainer to manage stacks via a web UI.

2) Create required folders (File Station; no SSH)
- Create these folders and ensure they are writable:
  - `/volume1/docker/dptb/profiles`
  - `/volume1/docker/dptb/logs`
  - `/volume1/docker/dptb/config`
- In File Station → Right-click each folder → Properties → Permission:
  - Grant Read/Write to your admin account (and "users" group if needed).
  - Apply to subfolders/files.

3) Deploy via Portainer Stacks (copy/paste)
- Portainer → Stacks → Add stack → Name: `dptb` → Web editor.
- Paste the compose below.
- Click “Environment variables” and add:
  - `FITBIT_CLIENT_ID`: your Fitbit client id
  - `FITBIT_CLIENT_SECRET`: your Fitbit client secret
- Deploy the stack.

```yaml
version: '3.8'

services:
  dptb:
    image: markraidc/dont-poke-the-bear:latest
    container_name: dptb-app
    user: "10001:10001"
    ports:
      - "9156:9000"            # App at http://NAS_IP:9156
    volumes:
      - /volume1/docker/dptb/profiles:/app/profiles
      - /volume1/docker/dptb/logs:/app/logs
      - /volume1/docker/dptb/config:/app/config:ro
    environment:
      - PYTHONIOENCODING=utf-8
      - PYTHONUNBUFFERED=1
      - TZ=America/New_York
      - PORT=9000
      - WORKERS=1
      - LOG_LEVEL=info
      # Manual OAuth mode (shows an authorization link to click)
      - FITBIT_REDIRECT_URI=https://localhost:8080/callback
      - FITBIT_CLIENT_ID=${FITBIT_CLIENT_ID}
      - FITBIT_CLIENT_SECRET=${FITBIT_CLIENT_SECRET}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
      - /var/tmp
```

4) First run
- Open `http://NAS_IP:9156`.
- Create a profile (e.g., `ammar`).
- Click Authorize:
  - You’ll see “manual” mode and an authorization URL.
  - Click the link, complete Fitbit sign-in, copy the redirected URL (or the code).
  - Paste it back into the app’s manual exchange form to save tokens.

5) Verify
- Profiles list shows your profile.
- Run a fetch; CSV files appear under `/volume1/docker/dptb/profiles/<profile>/csv/`.
- Healthcheck endpoint: `http://NAS_IP:9156/api/health` returns OK.

Troubleshooting
- Permission denied on “Create profile”:
  - Re-check folder permissions in File Station; ensure the three required folders are writable.
- Deployment error “NanoCPUs can not be set”:
  - The compose above avoids CPU quotas; if you use a different compose, remove CPU entries under `deploy: resources:` for Synology.
- Avatar and favicon 404s are harmless until you add those assets.


## Contact

For inquiries, contact: markraidc@gmail.com

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Copyright 2025 Mark Rai
