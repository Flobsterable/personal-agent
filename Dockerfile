FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY web ./web
COPY docs ./docs
USER node
CMD ["node", "src/main.js"]
