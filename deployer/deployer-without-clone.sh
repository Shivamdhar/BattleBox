#!/bin/bash

# 0. Arguments
MODE=$1  # Accept 'batch' or 'fast-track'
if [[ "$MODE" != "batch" && "$MODE" != "fast-track" ]]; then
    echo "❌ Usage: ./deployer.sh [batch|fast-track]"
    exit 1
fi


# 1. Configuration
REPO_URL="https://github.com/Name-X/BattleBox.git"
BRANCH_NAME="nameX/fastTrack"
APP_ROOT="/home/ubuntu/app_$MODE"
SUB_FOLDER="contest-app"
IMAGE_NAME="contest-app-$MODE"
BUCKET_NAME="my-contest-data-2026" 
NGINX_PORT=80

# Mode-Specific Settings
if [ "$MODE" == "batch" ]; then
    REPO_URL="https://github.com/Shivamdhar/BattleBox"
    BRANCH_NAME="main"
    PORT=3000
    NGINX_PORT=80
    BUCKET_NAME="my-contest-batch-2026"
else
    REPO_URL="https://github.com/Name-X/BattleBox"
    BRANCH_NAME="nameX/fastTrack"
    PORT=3001
    NGINX_PORT=81
    BUCKET_NAME="my-contest-fasttrack-2026"
fi


echo "🚀 Starting Deployment for [$MODE] on Port $NGINX_PORT..."



# 3. S3 Configuration Upload
echo "📤 Syncing $MODE Config to S3..."
cd $APP_ROOT/$SUB_FOLDER || exit 1

if [ -f "questions.json" ] && [ -f "answers.json" ]; then
    aws s3 cp questions.json s3://$BUCKET_NAME/questions.json
    aws s3 cp answers.json s3://$BUCKET_NAME/answers.json
else
    echo "⚠️ JSON files missing in repo. Using existing S3 config."
fi

# Fix permissions for Docker socket immediately
sudo chmod 666 /var/run/docker.sock


# 5. Generate Mode-Specific Nginx Config
echo "🛡️ Configuring Nginx Shield for $MODE..."
cat <<EOF > $APP_ROOT/nginx-$MODE.conf
events { worker_connections 1024; }
http {
    # Docker's internal DNS server
    resolver 127.0.0.11 valid=30s;

    limit_req_zone \$binary_remote_addr zone=contest_limit_$MODE:10m rate=15r/s;

    server {
        listen $NGINX_PORT;

        # We use a variable here so Nginx doesn't fail if the container is slow to start
        set \$upstream_endpoint http://contest-app-$MODE:3000;

        location / {
            limit_req zone=contest_limit_$MODE burst=30 nodelay;
            proxy_pass \$upstream_endpoint;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        }
    }
}
EOF

# 6. Docker Deployment with Environment Injection
echo "🧹 Cleaning up old containers for $MODE..."
docker stop nginx-shield-$MODE contest-app-$MODE || true
docker rm nginx-shield-$MODE contest-app-$MODE || true

# Ensure the network exists without deleting it (prevents 'No route to host')
docker network create contest-net-$MODE || true

echo "🛠️ Building $IMAGE_NAME.. and Launching App..."
cd $APP_ROOT/$SUB_FOLDER
DOCKER_BUILDKIT=0 docker build -t $IMAGE_NAME .

docker run -d \
  --name contest-app-$MODE \
  --network contest-net-$MODE \
  --restart unless-stopped \
  -e CONTEST_MODE=$MODE \
  -e BUCKET_NAME=$BUCKET_NAME \
  -v $APP_ROOT/data:/usr/src/app/data \
  $IMAGE_NAME

# IMPORTANT: Wait for App to initialize its network interface
echo "⏳ Waiting for app network to stabilize..."
sleep 5

echo "🚀 Launching Nginx Shield for $MODE..."
docker run -d \
  --name nginx-shield-$MODE \
  --network contest-net-$MODE \
  -p $NGINX_PORT:$NGINX_PORT \
  -v $APP_ROOT/nginx-$MODE.conf:/etc/nginx/nginx.conf:ro \
  --restart unless-stopped \
  nginx:latest

echo "✅ $MODE Deployment Complete! Access via port $NGINX_PORT"
