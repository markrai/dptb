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


### Synology NAS Deployment (Folder Preparation Only)

Container user and required directories
- The container runs as root UID:GID `0:0` (see `user: "0:0"` in the Synology compose).
- **Customizing the user**: If you prefer to run as a non-root user, you can change the `user:` setting in the compose file. To determine your UID and GID:
  - SSH into your Synology NAS and run: `id yourusername`
  - This will output something like: `uid=1024(yourusername) gid=100(users)`
  - Use these values in the compose file: `user: "1024:100"` (replace with your actual UID:GID)
  - Update the setup script to use the same UID:GID for folder ownership

Create required folders via Task Scheduler (single option)
1. Open DSM → Control Panel → Task Scheduler.
2. Create → Scheduled Task → User-defined script.
3. General tab:
   - Task: `DPTB Folder Prep`
   - User: `root`
   - Event: `Run on the following date` (pick any, one-time)
4. Task Settings tab → User-defined script: paste the contents of `synology-setup.sh` from this repo.
5. Click OK, then select the task and click Run.
6. Verify the following directories now exist and are writable by root (UID 0):
   - `/volume1/docker/dptb/profiles`
   - `/volume1/docker/dptb/logs`
   - `/volume1/docker/dptb/config`

#### Portainer Stack Deployment
- Open Portainer → Stacks → Add stack → Name: `dptb` → Web editor.
- Paste the compose below.
- Click “Environment variables” and add `FITBIT_CLIENT_ID` and `FITBIT_CLIENT_SECRET`.
- Deploy the stack, then open `http://NAS_IP:9156`.

```yaml
version: '3.8'

services:
  dptb:
    image: markraidc/dont-poke-the-bear:latest
    container_name: dptb-app
    user: "0:0"
    ports:
      - "9156:9000"
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


## Contact

For inquiries, contact: markraidc@gmail.com

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Copyright 2025 Mark Rai
