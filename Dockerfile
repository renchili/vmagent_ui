FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/vmagent-ui ./cmd/server

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/vmagent-ui /usr/local/bin/vmagent-ui
COPY public ./public
COPY config ./config
EXPOSE 3099
CMD ["/usr/local/bin/vmagent-ui"]
