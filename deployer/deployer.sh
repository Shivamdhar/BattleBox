#!/bin/bash

# 1. Configuration
REPO_URL="https://github.com/Name-X/BattleBox.git"
BRANCH_NAME="varun/contestApp"
APP_ROOT="/home/ubuntu/app"
SUB_FOLDER="contest-app"
IMAGE_NAME="contest-app"
BUCKET_NAME="my-contest-data-2026" # Must match your CloudFormation Parameter

echo "🚀 Starting Deployment..."

# 2. Clean and Clone
if [ -d "$APP_ROOT/temp_repo" ]; then sudo rm -rf $APP_ROOT/temp_repo; fi
mkdir -p $APP_ROOT/data

echo "📂 Cloning repository and switching to $BRANCH_NAME..."
git clone -b $BRANCH_NAME $REPO_URL $APP_ROOT/temp_repo

# 3. UPLOAD JSON FILES TO S3
# We do this BEFORE building so the app finds them on startup
echo "📤 Preparing S3 Upload..."
cd $APP_ROOT/temp_repo/$SUB_FOLDER || { echo "❌ Error: Could not find folder $SUB_FOLDER"; exit 1; }

echo "📍 Current Directory: $(pwd)"
echo "📄 Checking for files: $(ls -m)"

if [ -f "questions.json" ] && [ -f "answers.json" ]; then
    echo "🚀 Files found! Uploading to s3://$BUCKET_NAME..."
    aws s3 cp questions.json s3://$BUCKET_NAME/questions.json
    aws s3 cp answers.json s3://$BUCKET_NAME/answers.json
    
    # Verify upload success
    if [ $? -eq 0 ]; then
        echo "✅ S3 Sync Successful."
    else
        echo "❌ S3 Sync FAILED. Check IAM permissions or Bucket Name."
    fi
else
    echo "⚠️ Warning: JSON files not found in $(pwd)."
    echo "🔍 Search result: $(find .. -name "questions.json")"
    # Optional: Force exit if these are mandatory
    # exit 1 
fi

# 4. Move code and Cleanup
echo "📦 Finalizing file structure..."
cp -r $APP_ROOT/temp_repo/$SUB_FOLDER $APP_ROOT/
sudo rm -rf $APP_ROOT/temp_repo

# 5. Docker Build & Run
cd $APP_ROOT/$SUB_FOLDER
echo "🧹 Cleaning up old containers..."
docker stop $IMAGE_NAME || true
docker rm $IMAGE_NAME || true

echo "🛠 Building and Launching..."
docker build -t $IMAGE_NAME .
docker run -d \
  --name $IMAGE_NAME \
  -p 80:3000 \
  -v $APP_ROOT/data:/usr/src/app/data \
  --restart unless-stopped \
  $IMAGE_NAME

echo "✅ Deployment Complete!"