FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium

COPY src ./src

CMD ["npm", "start"]
