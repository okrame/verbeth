use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::Address;
use alloy::providers::{Provider, ProviderBuilder, RootProvider, WsConnect};
use alloy::pubsub::PubSubFrontend;
use alloy::rpc::types::{BlockTransactionsKind, Filter};
use alloy::sol_types::SolEvent;
use tokio::sync::watch;

use crate::db::queries::set_last_processed_block;
use crate::db::DbPool;
use crate::error::Result;

use super::events::{Handshake, HandshakeResponse, MessageSent};
use super::processor::{decode_log, EventProcessor, LogWithMeta};

pub async fn subscribe_with_reconnect(
    ws_url: String,
    contract_address: Address,
    pool: DbPool,
    mut shutdown: watch::Receiver<bool>,
) {
    let processor = EventProcessor::new(pool.clone());
    let mut backoff = Duration::from_secs(1);

    loop {
        if *shutdown.borrow() {
            tracing::info!("Subscriber received shutdown signal");
            break;
        }

        match connect_and_subscribe(&ws_url, contract_address, &processor, &pool, &mut shutdown)
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

async fn connect_and_subscribe(
    ws_url: &str,
    contract_address: Address,
    processor: &EventProcessor,
    pool: &DbPool,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<()> {
    tracing::info!("Connecting to WebSocket: {}", ws_url);

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

                let block_timestamp = fetch_block_timestamp(&provider, block_number).await?;

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
                        tracing::error!("Failed to process event: {e}");
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
