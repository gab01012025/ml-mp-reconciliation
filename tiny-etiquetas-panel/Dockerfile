FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN npm prune --production

EXPOSE 3002

CMD ["node", "dist/server.js"]
