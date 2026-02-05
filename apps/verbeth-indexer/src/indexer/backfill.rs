use std::collections::HashMap;
use std::num::NonZeroU32;
use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::Address;
use alloy::providers::{Provider, ProviderBuilder, RootProvider};
use alloy::rpc::types::{BlockTransactionsKind, Filter, Log};
use alloy::transports::http::{Client, Http};
use governor::{Jitter, Quota, RateLimiter};

use crate::db::queries::set_last_processed_block;
use crate::db::DbPool;
use crate::error::{IndexerError, Result};

use super::processor::{decode_log, EventProcessor, LogWithMeta};

// Alchemy Free tier: 500 CU/s, eth_getLogs = 75 CU → max ~6 req/s
const REQUESTS_PER_SECOND: u32 = 5;
const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF_MS: u64 = 1000;

pub struct BackfillStats {
    pub blocks_processed: u64,
    pub events_processed: u64,
    pub events_skipped: u64,
}

pub async fn run_backfill(
    rpc_url: &str,
    contract_address: Address,
    from_block: u64,
    to_block: u64,
    chunk_size: u64,
    pool: DbPool,
) -> Result<BackfillStats> {
    tracing::info!(
        "Starting backfill from block {} to {}",
        from_block,
        to_block
    );

    let provider = ProviderBuilder::new().on_http(rpc_url.parse().map_err(|e| {
        IndexerError::Config(format!("Invalid RPC URL: {e}"))
    })?);

    let processor = EventProcessor::new(pool.clone());

    let limiter = RateLimiter::direct(Quota::per_second(
        NonZeroU32::new(REQUESTS_PER_SECOND).unwrap(),
    ));

    let mut block_timestamps: HashMap<u64, u64> = HashMap::new();
    let mut stats = BackfillStats {
        blocks_processed: 0,
        events_processed: 0,
        events_skipped: 0,
    };

    for chunk_start in (from_block..=to_block).step_by(chunk_size as usize) {
        let chunk_end = (chunk_start + chunk_size - 1).min(to_block);

        limiter
            .until_ready_with_jitter(Jitter::up_to(Duration::from_millis(100)))
            .await;

        // Note: Don't use .events() for multiple signatures - it doesn't work as OR filter
        // Filter in code via decode_log() instead
        let filter = Filter::new()
            .address(contract_address)
            .from_block(chunk_start)
            .to_block(chunk_end);

        let logs = get_logs_with_retry(&provider, &filter).await?;

        let mut logs: Vec<_> = logs.into_iter().collect();
        logs.sort_by_key(|l| (l.block_number, l.log_index));

        let unique_blocks: Vec<u64> = logs
            .iter()
            .filter_map(|l| l.block_number)
            .filter(|b| !block_timestamps.contains_key(b))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        for block_num in unique_blocks {
            limiter.until_ready().await;
            let timestamp = fetch_block_timestamp_with_retry(&provider, block_num).await?;
            block_timestamps.insert(block_num, timestamp);
        }

        for log in logs {
            tracing::debug!("Got log with topic: {:?}", log.topics().first());
            let Some(event) = decode_log(&log) else {
                // Non-Verbeth events (Upgraded, OwnershipTransferred, etc.) - skip silently
                continue;
            };

            let block_number = log.block_number.unwrap_or(0);
            let log_index = log.log_index.unwrap_or(0);
            let block_timestamp = *block_timestamps.get(&block_number).unwrap_or(&0);

            let log_with_meta = LogWithMeta {
                event,
                block_number,
                log_index,
                block_timestamp,
            };

            match processor.process(log_with_meta) {
                Ok(true) => stats.events_processed += 1,
                Ok(false) => stats.events_skipped += 1,
                Err(e) => {
                    tracing::error!("Failed to process event: {e}");
                }
            }
        }

        let conn = pool.get()?;
        set_last_processed_block(&conn, chunk_end as i64)?;

        stats.blocks_processed = chunk_end - from_block + 1;

        let progress = (chunk_end - from_block) as f64 / (to_block - from_block).max(1) as f64 * 100.0;
        tracing::info!(
            "Backfill progress: {}/{} blocks ({:.1}%), {} events",
            stats.blocks_processed,
            to_block - from_block + 1,
            progress,
            stats.events_processed
        );
    }

    tracing::info!(
        "Backfill complete: {} blocks, {} events processed, {} skipped",
        stats.blocks_processed,
        stats.events_processed,
        stats.events_skipped
    );

    Ok(stats)
}

async fn get_logs_with_retry(
    provider: &RootProvider<Http<Client>>,
    filter: &Filter,
) -> Result<Vec<Log>> {
    let mut attempt = 0;
    loop {
        match provider.get_logs(filter).await {
            Ok(logs) => return Ok(logs),
            Err(e) => {
                let is_rate_limit = e.to_string().contains("429")
                    || e.to_string().contains("exceeded")
                    || e.to_string().contains("rate");

                if is_rate_limit && attempt < MAX_RETRIES {
                    attempt += 1;
                    let backoff = Duration::from_millis(INITIAL_BACKOFF_MS * 2u64.pow(attempt - 1));
                    tracing::warn!(
                        "Rate limited, retrying in {:?} (attempt {}/{})",
                        backoff,
                        attempt,
                        MAX_RETRIES
                    );
                    tokio::time::sleep(backoff).await;
                } else {
                    return Err(e.into());
                }
            }
        }
    }
}

async fn fetch_block_timestamp_with_retry(
    provider: &RootProvider<Http<Client>>,
    block_num: u64,
) -> Result<u64> {
    let mut attempt = 0;
    loop {
        match provider
            .get_block_by_number(
                BlockNumberOrTag::Number(block_num),
                BlockTransactionsKind::Hashes,
            )
            .await
        {
            Ok(Some(block)) => return Ok(block.header.timestamp),
            Ok(None) => return Err(IndexerError::BlockNotFound(block_num)),
            Err(e) => {
                let is_rate_limit = e.to_string().contains("429")
                    || e.to_string().contains("exceeded")
                    || e.to_string().contains("rate");

                if is_rate_limit && attempt < MAX_RETRIES {
                    attempt += 1;
                    let backoff = Duration::from_millis(INITIAL_BACKOFF_MS * 2u64.pow(attempt - 1));
                    tracing::warn!(
                        "Rate limited fetching block {}, retrying in {:?} (attempt {}/{})",
                        block_num,
                        backoff,
                        attempt,
                        MAX_RETRIES
                    );
                    tokio::time::sleep(backoff).await;
                } else {
                    return Err(e.into());
                }
            }
        }
    }
}

#[allow(dead_code)]
pub async fn get_chain_head(provider: &RootProvider<Http<Client>>) -> Result<u64> {
    Ok(provider.get_block_number().await?)
}
