#!/bin/bash

# 1. Configuration
REPO_URL="https://github.com/your-username/your-repo.git"
APP_DIR="/home/ubuntu/app"
IMAGE_NAME="contest-app"

echo "🚀 Starting Deployment..."

# 2. Navigate to app directory or clone if first time
if [ ! -d "$APP_DIR/.git" ]; then
    echo "📂 Cloning repository..."
    git clone $REPO_URL $APP_DIR
    cd $APP_DIR
else
    echo "🔄 Pulling latest code..."
    cd $APP_DIR
    git pull origin main
fi

# 3. Stop and remove old container if it exists
echo "🧹 Cleaning up old containers..."
docker stop $IMAGE_NAME || true
docker rm $IMAGE_NAME || true

# 4. Build the new image (The 2GB Swap file handles the load)
echo "🛠 Building Docker image..."
docker build -t $IMAGE_NAME .

# 5. Run the container
# Note: We mount the /data folder for SQLite persistence
echo "🚢 Launching container..."
docker run -d \
  --name $IMAGE_NAME \
  -p 80:3000 \
  -v $APP_DIR/data:/usr/src/app/data \
  --restart unless-stopped \
  $IMAGE_NAME

echo "✅ Deployment Complete! App is live on Port 80."