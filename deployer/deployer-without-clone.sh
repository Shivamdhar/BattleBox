#!/bin/bash

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
cd $APP_ROOT/temp_repo/$SUB_FOLDER || exit 1

if [ -f "questions.json" ] && [ -f "answers.json" ]; then
    aws s3 cp questions.json s3://$BUCKET_NAME/questions.json
    aws s3 cp answers.json s3://$BUCKET_NAME/answers.json
else
    echo "⚠️ JSON files missing in repo. Using existing S3 config."
fi

# 4. Move code and Cleanup
echo "📦 Finalizing file structure..."
cp -r $APP_ROOT/temp_repo/$SUB_FOLDER $APP_ROOT/
sudo rm -rf $APP_ROOT/temp_repo

# Fix permissions for Docker socket immediately
sudo chmod 666 /var/run/docker.sock

# 5. SECURITY LAYER: Updated for Browser Compatibility
echo "🛡️ Configuring Nginx Shield for $MODE..."
cat <<EOF > $APP_ROOT/nginx-$MODE.conf
events { worker_connections 1024; }

http {
    # limit_req is better for browsers than limit_conn
    # rate=10r/s allows 10 requests per second per IP
    limit_req_zone \$binary_remote_addr zone=contest_limit_$MODE:10m rate=15r/s;

    server {
        listen $NGINX_PORT;

        location / {
            # burst=20: Allows a user to load many files (CSS/JS) at once
            # nodelay: Ensures the page feels fast for real users
            limit_req zone=contest_limit_$MODE burst=30 nodelay;

            proxy_pass http://contest-app-$MODE:3000;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            
            proxy_connect_timeout 90;
            proxy_send_timeout 90;
            proxy_read_timeout 90;
        }
        location /nginx_status {
            stub_status;
            allow 172.18.0.0/16; # Allow the Docker network to see stats
            allow 127.0.0.1;
            deny all;
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
docker build -t $IMAGE_NAME .

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
