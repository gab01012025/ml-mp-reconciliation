FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Diretório persistente para tokens e cache (montar volume aqui)
RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/index.js"]
