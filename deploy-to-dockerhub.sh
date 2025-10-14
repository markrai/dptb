#!/bin/bash
# Docker Hub Deployment Script for "Don't Poke the Bear!"

# Configuration - UPDATE THESE VALUES
DOCKER_USERNAME="markraidc"  # Docker Hub username
IMAGE_NAME="dont-poke-the-bear"
VERSION="v1.0"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐻 Deploying 'Don't Poke the Bear!' to Docker Hub${NC}"
echo -e "${YELLOW}Repository: ${DOCKER_USERNAME}/${IMAGE_NAME}${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker and try again.${NC}"
    exit 1
fi

# Check if logged into Docker Hub
if ! docker info | grep -q "Username:"; then
    echo -e "${YELLOW}⚠️  Not logged into Docker Hub. Please run 'docker login' first.${NC}"
    echo "Run: docker login"
    exit 1
fi

echo -e "${BLUE}📦 Building Docker image...${NC}"
if docker build -t ${DOCKER_USERNAME}/${IMAGE_NAME}:latest .; then
    echo -e "${GREEN}✅ Image built successfully${NC}"
else
    echo -e "${RED}❌ Image build failed${NC}"
    exit 1
fi

echo -e "${BLUE}🏷️  Tagging image for version ${VERSION}...${NC}"
if docker tag ${DOCKER_USERNAME}/${IMAGE_NAME}:latest ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}; then
    echo -e "${GREEN}✅ Image tagged successfully${NC}"
else
    echo -e "${RED}❌ Image tagging failed${NC}"
    exit 1
fi

echo -e "${BLUE}🚀 Pushing latest version to Docker Hub...${NC}"
if docker push ${DOCKER_USERNAME}/${IMAGE_NAME}:latest; then
    echo -e "${GREEN}✅ Latest version pushed successfully${NC}"
else
    echo -e "${RED}❌ Push failed${NC}"
    exit 1
fi

echo -e "${BLUE}🚀 Pushing version ${VERSION} to Docker Hub...${NC}"
if docker push ${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}; then
    echo -e "${GREEN}✅ Version ${VERSION} pushed successfully${NC}"
else
    echo -e "${RED}❌ Push failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo -e "${YELLOW}📋 Your image is now available at:${NC}"
echo -e "   ${BLUE}https://hub.docker.com/r/${DOCKER_USERNAME}/${IMAGE_NAME}${NC}"
echo ""
echo -e "${YELLOW}📋 Usage Commands:${NC}"
echo -e "   ${BLUE}docker pull ${DOCKER_USERNAME}/${IMAGE_NAME}:latest${NC}"
echo -e "   ${BLUE}docker run -p 9000:9000 ${DOCKER_USERNAME}/${IMAGE_NAME}:latest${NC}"
echo ""
echo -e "${YELLOW}📋 Docker Compose Example:${NC}"
echo -e "${BLUE}services:${NC}"
echo -e "${BLUE}  dont-poke-the-bear:${NC}"
echo -e "${BLUE}    image: ${DOCKER_USERNAME}/${IMAGE_NAME}:latest${NC}"
echo -e "${BLUE}    ports:${NC}"
echo -e "${BLUE}      - \"9000:9000\"${NC}"
echo ""
echo -e "${GREEN}🐻 Don't Poke the Bear! is now live on Docker Hub! 🐻${NC}"
