FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    LITFETCH_LIBRARY=/library
RUN mkdir /library && chown node:node /library
VOLUME /library
EXPOSE 3000

USER node

# Web UI by default; run the CLI with: docker run … litfetch node src/cli.js <command>
CMD ["node", "server/index.js"]
