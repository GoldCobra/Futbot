FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY data ./data
COPY scripts ./scripts
COPY src ./src

CMD ["npm", "start"]
