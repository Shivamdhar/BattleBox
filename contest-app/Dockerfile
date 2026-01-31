# STAGE 1: The Builder
# We use a slightly beefier image here because sqlite3 needs python/make/g++ to compile
FROM node:18-slim AS builder

WORKDIR /usr/src/app

# Install system tools needed for building SQLite3 bindings
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Install ALL dependencies (including those needed to build sqlite3)
RUN npm install

# ---

# STAGE 2: The Production Image
# This is the final image that will live on your EC2
FROM node:18-slim

WORKDIR /usr/src/app

# Set environment to production
ENV NODE_ENV=production

# Copy only the built node_modules and the source code from the builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Create a 'data' directory for the SQLite database file
# We will map this to an EC2 volume so your scores aren't lost on restart
RUN mkdir -p data && chown -R node:node /usr/src/app

# Use the non-root 'node' user for security
USER node

EXPOSE 3000

CMD [ "node", "server.js" ]