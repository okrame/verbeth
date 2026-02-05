FROM rust:1.84-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/verbeth-indexer /usr/local/bin/
ENV DATABASE_PATH=/data/indexer.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["verbeth-indexer"]
