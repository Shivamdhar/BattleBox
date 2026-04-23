#!/bin/bash


# 0. Arguments
MODE=$1  # Accept 'batch' or 'fast-track'
if [[ "$MODE" != "batch" && "$MODE" != "fast-track" ]]; then
    echo "❌ Usage: ./deployer.sh [batch|fast-track]"
    exit 1
fi


# Mode-Specific Settings
if [ "$MODE" == "batch" ]; then
    BUCKET_NAME="my-contest-batch-2026"
else
    BUCKET_NAME="my-contest-fasttrack-2026"
fi

# 1. Configuration - MUST MATCH YOUR STACK
STACK_NAME="ContestServerStack" # Change this to your actual stack name

echo "⚠️  WARNING: This will permanently delete your S3 files and the AWS Stack."
read -p "Are you sure you want to proceed? (y/n): " confirm
if [[ $confirm != [yY] ]]; then
    echo "❌ Cleanup cancelled."
    exit 1
fi

echo "🗑️  Step 1: Emptying S3 bucket: $BUCKET_NAME..."
# Deletes all objects and all versions (if versioning was enabled)
aws s3 rm s3://$BUCKET_NAME --recursive

if [ $? -eq 0 ]; then
    echo "✅ Bucket emptied successfully."
else
    echo "⚠️  Bucket might already be empty or doesn't exist. Continuing..."
fi

echo "🔥 Step 2: Deleting CloudFormation Stack: $STACK_NAME..."
aws cloudformation delete-stack --stack-name $STACK_NAME

echo "⏳ Step 3: Waiting for stack deletion to complete..."
aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME

# 4. Local Cleanup
echo "🧹 Step 4: Cleaning up local temporary files..."
rm -f my-contest-key.pem
rm -f nginx-contest.conf
rm -f slow-down.html

echo "✨ Cleanup Complete! All AWS resources have been removed."