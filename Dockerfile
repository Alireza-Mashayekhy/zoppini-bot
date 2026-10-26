FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV BOT_HEARTBEAT_FILE=/tmp/bot-heartbeat.json

COPY package.json bot.mjs ./
COPY src ./src

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "bot.mjs", "--healthcheck"]

USER node
CMD ["node", "bot.mjs"]
