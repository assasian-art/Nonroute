FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=10000
ENV OMNIROUTE_INTERNAL_PORT=20128
EXPOSE 10000

CMD ["npm", "start"]
