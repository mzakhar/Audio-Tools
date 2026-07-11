FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY electron.vite.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine

COPY deploy/nginx/synth.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out/renderer /usr/share/nginx/html

EXPOSE 8080

