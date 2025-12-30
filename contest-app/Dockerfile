# Use a lightweight Node.js image
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install --production

# Bundle app source
COPY . .

# Your app binds to port 3000
EXPOSE 3000

# Define the command to run your app
CMD [ "node", "server.js" ]