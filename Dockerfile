FROM node:20-alpine

WORKDIR /app

COPY line-deepseek-zeabur-demo/package*.json ./
RUN npm ci --omit=dev

COPY line-deepseek-zeabur-demo/server.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
