FROM node:24-bookworm-slim

ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node api ./api
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
