#!/bin/bash
# DPTB Synology Setup Script
# Creates required directories with proper permissions for container deployment

mkdir -p /volume1/docker/dptb/profiles
mkdir -p /volume1/docker/dptb/logs
mkdir -p /volume1/docker/dptb/config

chown -R 0:0 /volume1/docker/dptb/profiles
chown -R 0:0 /volume1/docker/dptb/logs
chown -R 0:0 /volume1/docker/dptb/config

chmod -R 775 /volume1/docker/dptb/profiles
chmod -R 775 /volume1/docker/dptb/logs
chmod -R 775 /volume1/docker/dptb/config
