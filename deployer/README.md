##Deployer

Folder containing information about deployment of the contest-app on AWS cloud. Components used in aws would be EC2 instance , S3 etc

1. Setup the ~/.aws/config as per your creds

[default]
region = us-east-1
aws_access_key_id = <your_access_key>
aws_secret_access_key = <your_secret_key>

2. Invoke the following command to create the stack and needed resources
aws cloudformation create-stack \
  --stack-name ContestServerStack \
  --template-body file://contest-stack.yaml \
  --parameters \
    ParameterKey=KeyName,ParameterValue=ContestInstance \
    ParameterKey=AdminUsername,ParameterValue=admin \
    ParameterKey=AdminPassword,ParameterValue=secure-password-123 \
    ParameterKey=BucketName,ParameterValue=my-contest-data-2026 \
  --capabilities CAPABILITY_IAM


3. Once stack is completed , get the EC2 instance IP from UI and login to the EC2 instance
4. create deployer.sh file in the instance and copy the contents from deployer.sh in this repo
5. change permissions for the file (chmod +x deployer.sh)
6. Execute the deployer.sh (./deployer.sh)
7. This script will clone the repo and deploy the UI (via docker) which would be accessible by your private ip endpoint with http://<your_ip>