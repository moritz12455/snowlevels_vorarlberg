# --- Frontend bauen ---
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Backend bauen ---
FROM golang:1.24-alpine AS api
WORKDIR /src
COPY backend/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /schneehoehe-api .

# --- Laufzeit ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=api /schneehoehe-api /app/schneehoehe-api
COPY --from=web /web/dist /app/web
ENV STATIC_DIR=/app/web PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/schneehoehe-api"]
