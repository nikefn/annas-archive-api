FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Inside the container the UI must listen on all interfaces; publish the port
# on the host's loopback only: docker run -p 127.0.0.1:3000:3000 ...
ENV NODE_ENV=production \
    LITFETCH_UI_HOST=0.0.0.0 \
    LITFETCH_UI_PORT=3000 \
    LITFETCH_LIBRARY=/library
RUN mkdir /library && chown node:node /library
VOLUME /library
EXPOSE 3000

USER node

# Web UI by default; for the CLI: docker run ... litfetch node src/cli.js <command>
CMD ["node", "server/index.js"]
