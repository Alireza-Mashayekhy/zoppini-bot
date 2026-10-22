FROM node:22-alpine

WORKDIR /app

# ربات هیچ وابستگی npm ندارد؛ فقط همین دو فایل برای اجرا کافی است.
COPY package.json bot.mjs ./

USER node

# مقادیر محیطی از docker compose / env_file می‌آیند، پس بدون --env-file اجرا می‌شود.
CMD ["node", "bot.mjs"]
