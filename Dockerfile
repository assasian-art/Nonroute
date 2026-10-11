FROM node:22.22.2-bookworm-slim

ENV NODE_ENV=production
ENV PORT=10000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/var/data/omniroute
ENV OMNIROUTE_DATA_DIR=/var/data/omniroute
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 10000
CMD ["node", "node_modules/omniroute/bin/omniroute.mjs"]
