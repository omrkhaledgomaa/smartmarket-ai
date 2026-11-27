FROM node:22.16-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data COOKIE_SECURE=true
WORKDIR /app
COPY package.json server.js public.html admin.html./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
