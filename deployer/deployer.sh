#!/bin/bash

# 1. Configuration
REPO_URL="https://github.com/Name-X/BattleBox.git"
BRANCH_NAME="varun/contestApp"
APP_ROOT="/home/ubuntu/app"
SUB_FOLDER="contest-app"
IMAGE_NAME="contest-app"
BUCKET_NAME="my-contest-data-2026" 

echo "🚀 Starting Deployment..."

# 2. Clean and Clone
if [ -d "$APP_ROOT/temp_repo" ]; then sudo rm -rf $APP_ROOT/temp_repo; fi
mkdir -p $APP_ROOT/data

echo "📂 Cloning repository and switching to $BRANCH_NAME..."
git clone -b $BRANCH_NAME $REPO_URL $APP_ROOT/temp_repo

# 3. UPLOAD JSON FILES TO S3
echo "📤 Preparing S3 Upload..."
cd $APP_ROOT/temp_repo/$SUB_FOLDER || { echo "❌ Error: Folder $SUB_FOLDER not found"; exit 1; }

if [ -f "questions.json" ] && [ -f "answers.json" ]; then
    echo "🚀 Uploading to s3://$BUCKET_NAME..."
    aws s3 cp questions.json s3://$BUCKET_NAME/questions.json
    aws s3 cp answers.json s3://$BUCKET_NAME/answers.json
    echo "✅ S3 Sync Successful."
else
    echo "⚠️ Warning: JSON files not found. Skipping S3 upload."
fi

# 4. Move code and Cleanup
echo "📦 Finalizing file structure..."
cp -r $APP_ROOT/temp_repo/$SUB_FOLDER $APP_ROOT/
sudo rm -rf $APP_ROOT/temp_repo

# Fix permissions for Docker socket immediately
sudo chmod 666 /var/run/docker.sock

# 5. SECURITY LAYER: Updated for Browser Compatibility
echo "🛡️ Configuring Nginx Shield..."
cat <<EOF > $APP_ROOT/nginx-contest.conf
events { worker_connections 1024; }

http {
    # limit_req is better for browsers than limit_conn
    # rate=10r/s allows 10 requests per second per IP
    limit_req_zone \$binary_remote_addr zone=contest_limit:10m rate=10r/s;

    server {
        listen 80;

        location / {
            # burst=20: Allows a user to load many files (CSS/JS) at once
            # nodelay: Ensures the page feels fast for real users
            limit_req zone=contest_limit burst=20 nodelay;

            proxy_pass http://contest-app:3000;
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

# 6. DOCKER DEPLOYMENT
echo "🧹 Cleaning up old containers..."
docker stop nginx-shield contest-app || true
docker rm nginx-shield contest-app || true

# Ensure the network exists without deleting it (prevents 'No route to host')
docker network create contest-net || true

echo "🛠️ Building and Launching App..."
cd $APP_ROOT/$SUB_FOLDER
docker build -t $IMAGE_NAME .

docker run -d \
  --name contest-app \
  --network contest-net \
  --restart unless-stopped \
  -v $APP_ROOT/data:/usr/src/app/data \
  $IMAGE_NAME

# IMPORTANT: Wait for App to initialize its network interface
echo "⏳ Waiting for app network to stabilize..."
sleep 5

echo "🚀 Launching Nginx Shield..."
docker run -d \
  --name nginx-shield \
  --network contest-net \
  -p 80:80 \
  -v $APP_ROOT/nginx-contest.conf:/etc/nginx/nginx.conf:ro \
  --restart unless-stopped \
  nginx:latest

echo "✅ Deployment Complete!"