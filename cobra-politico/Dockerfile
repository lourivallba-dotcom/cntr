FROM node:22-alpine
WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/dados/cobra-politico.sqlite UPLOADS_DIR=/dados/uploads CACHE_DIR=/dados/cache
VOLUME /dados
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
