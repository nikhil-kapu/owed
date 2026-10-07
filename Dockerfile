FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY agent ./agent
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
