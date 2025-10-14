# Synology NAS Deployment Guide for FitBaus

## Prerequisites
- Synology NAS with Container Manager installed
- At least 1GB RAM available
- Docker support enabled
- Fitbit Developer App credentials

## Step 1: Prepare Your Synology NAS

### 1.1 Install Container Manager
1. Open Package Center
2. Search for "Container Manager"
3. Install and launch Container Manager

### 1.2 Create Directory Structure
```bash
# SSH into your NAS or use File Station
mkdir -p /volume1/docker/fitbaus/profiles
mkdir -p /volume1/docker/fitbaus/logs
mkdir -p /volume1/docker/fitbaus/config
mkdir -p /volume1/docker/fitbaus/ssl
```

### 1.3 Set Permissions
```bash
# Set proper permissions for Docker
chown -R 10001:10001 /volume1/docker/fitbaus/profiles
chown -R 10001:10001 /volume1/docker/fitbaus/logs
chmod 755 /volume1/docker/fitbaus/profiles
chmod 755 /volume1/docker/fitbaus/logs
```

## Step 2: Upload Your Application

### 2.1 Copy Files to NAS
Upload these files to `/volume1/docker/fitbaus/`:
- `docker-compose.synology.yml`
- `Dockerfile.synology`
- `gunicorn.synology.conf.py`
- `server.py`
- `spousal.html`
- `style.css`
- `requirements.txt`
- `auth/` directory
- `common/` directory
- `fetch/` directory
- `generate/` directory
- `assets/` directory

### 2.2 Rename Files for Synology
```bash
cd /volume1/docker/fitbaus/
mv docker-compose.synology.yml docker-compose.yml
mv Dockerfile.synology Dockerfile
mv gunicorn.synology.conf.py gunicorn.conf.py
```

## Step 3: Configure Environment Variables

### 3.1 Create .env File
Create `/volume1/docker/fitbaus/.env`:
```env
FITBIT_CLIENT_ID=your_fitbit_client_id
FITBIT_CLIENT_SECRET=your_fitbit_client_secret
TZ=America/New_York
```

### 3.2 Update Fitbit OAuth Settings
1. Go to your Fitbit Developer App settings
2. Update Redirect URI to: `https://your-nas-ip:9000/callback`
3. Or use your domain: `https://your-domain.com:9000/callback`

## Step 4: Deploy with Container Manager

### 4.1 Import Project
1. Open Container Manager
2. Go to "Project" tab
3. Click "Create" → "From docker-compose.yml"
4. Select `/volume1/docker/fitbaus/docker-compose.yml`
5. Name: "fitbaus"
6. Click "Next" → "Done"

### 4.2 Start the Container
1. Find "fitbaus" project
2. Click "Start"
3. Monitor logs for successful startup

## Step 5: Configure Synology Reverse Proxy (Optional)

### 5.1 Enable Reverse Proxy
1. Open Control Panel → Application Portal
2. Go to "Reverse Proxy" tab
3. Click "Create"

### 5.2 Configure Reverse Proxy
- **Source Protocol**: HTTPS
- **Source Hostname**: your-domain.com
- **Source Port**: 443
- **Destination Protocol**: HTTP
- **Destination Hostname**: localhost
- **Destination Port**: 9000

## Step 6: Access Your Application

### 6.1 Local Access
- URL: `http://your-nas-ip:9000`
- Example: `http://192.168.1.100:9000`

### 6.2 External Access (with Reverse Proxy)
- URL: `https://your-domain.com`
- SSL certificate required

## Step 7: Monitoring and Maintenance

### 7.1 Resource Monitoring
- Use Synology Resource Monitor
- Monitor CPU, Memory, and Disk usage
- Set up alerts for resource limits

### 7.2 Log Management
- Logs stored in: `/volume1/docker/fitbaus/logs/`
- Automatic log rotation configured
- Monitor for errors in Container Manager

### 7.3 Backup Strategy
- Backup `/volume1/docker/fitbaus/profiles/` directory
- Use Synology Hyper Backup for automated backups
- Test restore procedures

## Troubleshooting

### Common Issues

#### Container Won't Start
```bash
# Check logs
docker logs fitbaus-app

# Check permissions
ls -la /volume1/docker/fitbaus/profiles/
```

#### Permission Errors
```bash
# Fix permissions
chown -R 10001:10001 /volume1/docker/fitbaus/
```

#### Memory Issues
- Reduce `WORKERS=1` in docker-compose.yml
- Increase NAS RAM or add swap
- Monitor with Resource Monitor

#### Network Issues
- Check firewall settings
- Verify port 9000 is accessible
- Test with `telnet your-nas-ip 9000`

### Performance Optimization

#### For Low-End NAS
```yaml
# In docker-compose.yml
deploy:
  resources:
    limits:
      memory: 256M
      cpus: '0.25'
```

#### For High-End NAS
```yaml
# In docker-compose.yml
deploy:
  resources:
    limits:
      memory: 1G
      cpus: '1.0'
```

## Security Considerations

1. **Change default ports** if needed
2. **Use HTTPS** with reverse proxy
3. **Regular updates** of container images
4. **Monitor access logs** for suspicious activity
5. **Backup Fitbit credentials** securely

## Support

- Check Container Manager logs first
- Monitor Synology Resource Monitor
- Review application logs in `/volume1/docker/fitbaus/logs/`
- Ensure all volume mounts are accessible
