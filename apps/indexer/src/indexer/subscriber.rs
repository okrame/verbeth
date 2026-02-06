use std::sync::Arc;
use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::Address;
use alloy::providers::{Provider, ProviderBuilder, RootProvider, WsConnect};
use alloy::pubsub::PubSubFrontend;
use alloy::rpc::types::{BlockTransactionsKind, Filter};
use alloy::sol_types::SolEvent;
use tokio::sync::watch;

use crate::config::{sanitize_rpc_url, Config};
use crate::db::queries::{get_last_processed_block, set_last_processed_block};
use crate::db::DbPool;
use crate::error::Result;

use super::backfill::run_backfill;
use super::events::{Handshake, HandshakeResponse, MessageSent};
use super::processor::{decode_log, EventProcessor, LogWithMeta};
use super::retry_queue::RetryQueue;

const RETRY_INTERVAL_SECS: u64 = 10;

pub async fn subscribe_with_reconnect(
    config: Arc<Config>,
    pool: DbPool,
    mut shutdown: watch::Receiver<bool>,
) {
    let processor = Arc::new(EventProcessor::new(pool.clone()));
    let retry_queue = Arc::new(RetryQueue::new());
    let mut backoff = Duration::from_secs(1);
    let mut is_first_connect = true;

    // Spawn background retry task
    let retry_processor = processor.clone();
    let retry_q = retry_queue.clone();
    let retry_pool = pool.clone();
    let retry_shutdown = shutdown.clone();
    tokio::spawn(async move {
        run_retry_loop(retry_q, retry_processor, retry_pool, retry_shutdown).await;
    });

    loop {
        if *shutdown.borrow() {
            tracing::info!("Subscriber received shutdown signal");
            break;
        }

        // Recover missed events via HTTP before (re)connecting WS
        // Skip on first connect since main.rs already does initial backfill
        if !is_first_connect {
            if let Err(e) = recover_missed_events(&config, &pool).await {
                tracing::warn!("Failed to recover missed events: {e}");
            }
        }
        is_first_connect = false;

        match connect_and_subscribe(
            &config.rpc_ws_url,
            config.contract_address,
            &processor,
            &retry_queue,
            &pool,
            &mut shutdown,
        )
        .await
        {
            Ok(()) => {
                tracing::info!("Subscriber shut down gracefully");
                break;
            }
            Err(e) => {
                tracing::warn!("Subscriber error: {e}, reconnecting in {:?}", backoff);
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            break;
                        }
                    }
                }
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
    }
}

async fn recover_missed_events(config: &Config, pool: &DbPool) -> Result<()> {
    let conn = pool.get()?;
    let last_block = get_last_processed_block(&conn)?.unwrap_or(0) as u64;
    drop(conn);

    // Derive HTTP URL from WS URL if not explicitly set
    let http_url = config.rpc_http_url.clone().unwrap_or_else(|| {
        config
            .rpc_ws_url
            .replace("wss://", "https://")
            .replace("ws://", "http://")
    });

    let provider = ProviderBuilder::new().on_http(http_url.parse().map_err(|e| {
        crate::error::IndexerError::Config(format!("Invalid HTTP RPC URL: {e}"))
    })?);

    let chain_head = provider.get_block_number().await?;

    if chain_head <= last_block {
        tracing::debug!("No missed blocks to recover");
        return Ok(());
    }

    let gap = chain_head - last_block;
    tracing::info!(
        "Recovering {} missed blocks ({} -> {})",
        gap,
        last_block + 1,
        chain_head
    );

    run_backfill(
        &http_url,
        config.contract_address,
        last_block + 1,
        chain_head,
        config.rpc_chunk_size,
        pool.clone(),
    )
    .await?;

    tracing::info!("Recovery complete");
    Ok(())
}

async fn run_retry_loop(
    queue: Arc<RetryQueue>,
    processor: Arc<EventProcessor>,
    pool: DbPool,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    tracing::debug!("Retry loop shutting down");
                    return;
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(RETRY_INTERVAL_SECS)) => {
                while let Some(failed) = queue.pop().await {
                    let block_number = failed.log.block_number;
                    let log_clone = failed.log.clone();
                    match processor.process(log_clone) {
                        Ok(true) => {
                            tracing::info!(
                                block = block_number,
                                attempt = failed.retry_count + 1,
                                "Retry succeeded"
                            );
                            if let Ok(conn) = pool.get() {
                                let _ = set_last_processed_block(&conn, block_number as i64);
                            }
                        }
                        Ok(false) => {
                            tracing::debug!(block = block_number, "Retry: duplicate event");
                        }
                        Err(e) => {
                            // Re-queue for another retry attempt
                            queue.push_retry(failed, e.to_string()).await;
                        }
                    }
                }
            }
        }
    }
}

async fn connect_and_subscribe(
    ws_url: &str,
    contract_address: Address,
    processor: &Arc<EventProcessor>,
    retry_queue: &Arc<RetryQueue>,
    pool: &DbPool,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<()> {
    tracing::info!("Connecting to WebSocket: {}", sanitize_rpc_url(ws_url));

    let ws = WsConnect::new(ws_url);
    let provider = ProviderBuilder::new().on_ws(ws).await?;

    tracing::info!("Connected, subscribing to events...");

    let filter = Filter::new().address(contract_address).events([
        MessageSent::SIGNATURE_HASH,
        Handshake::SIGNATURE_HASH,
        HandshakeResponse::SIGNATURE_HASH,
    ]);

    let sub = provider.subscribe_logs(&filter).await?;
    let mut stream = sub.into_stream();

    tracing::info!("Subscribed to Verbeth events");

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(());
                }
            }
            log_opt = futures_lite::StreamExt::next(&mut stream) => {
                let log = match log_opt {
                    Some(log) => log,
                    None => {
                        tracing::warn!("WebSocket stream ended");
                        return Err(crate::error::IndexerError::Config("Stream ended".into()));
                    }
                };

                let block_number = log.block_number.unwrap_or(0);
                let log_index = log.log_index.unwrap_or(0);

                let Some(event) = decode_log(&log) else {
                    tracing::debug!("Unknown event at block {}", block_number);
                    continue;
                };

                let block_timestamp = match fetch_block_timestamp(&provider, block_number).await {
                    Ok(ts) => ts,
                    Err(e) => {
                        tracing::warn!("Failed to fetch block timestamp: {e}");
                        continue;
                    }
                };

                let log_with_meta = LogWithMeta {
                    event,
                    block_number,
                    log_index,
                    block_timestamp,
                };

                match processor.process(log_with_meta) {
                    Ok(true) => {
                        tracing::debug!("Processed event at block {}", block_number);
                        let conn = pool.get()?;
                        set_last_processed_block(&conn, block_number as i64)?;
                    }
                    Ok(false) => {
                        tracing::debug!("Duplicate event at block {}", block_number);
                    }
                    Err(e) => {
                        tracing::warn!(
                            block = block_number,
                            log_index = log_index,
                            error = %e,
                            "Failed to process event, queuing for retry"
                        );
                        // Re-create log_with_meta for retry (need to re-decode)
                        if let Some(event) = decode_log(&log) {
                            let retry_log = LogWithMeta {
                                event,
                                block_number,
                                log_index,
                                block_timestamp,
                            };
                            retry_queue.push(retry_log, e.to_string()).await;
                        }
                    }
                }
            }
        }
    }
}

async fn fetch_block_timestamp(
    provider: &RootProvider<PubSubFrontend>,
    block_number: u64,
) -> Result<u64> {
    let block = provider
        .get_block_by_number(
            BlockNumberOrTag::Number(block_number),
            BlockTransactionsKind::Hashes,
        )
        .await?
        .ok_or(crate::error::IndexerError::BlockNotFound(block_number))?;

    Ok(block.header.timestamp)
}
