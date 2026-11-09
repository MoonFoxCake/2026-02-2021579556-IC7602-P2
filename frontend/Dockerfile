FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.21.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV VITE_API_BASE_URL=/api VITE_DISABLE_TELEMETRY=true
RUN pnpm build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
