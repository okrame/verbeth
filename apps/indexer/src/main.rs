use std::net::SocketAddr;

use alloy::providers::{Provider, ProviderBuilder};
use tokio::sync::watch;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod api;
mod config;
mod db;
mod error;
mod indexer;

use api::AppState;
use config::Config;
use db::{create_pool, queries};
use error::Result;
use indexer::{backfill, subscriber};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env()?;

    tracing::info!(
        "Starting Verbeth Indexer v{}",
        env!("CARGO_PKG_VERSION")
    );
    tracing::info!("Contract: {}", config.contract_address);
    tracing::info!("Database: {}", config.database_path);
    tracing::info!("RPC chunk size: {} blocks", config.rpc_chunk_size);

    let pool = create_pool(&config.database_path)?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let conn = pool.get()?;
    let is_empty = queries::is_db_empty(&conn)?;
    let last_block = queries::get_last_processed_block(&conn)?;
    drop(conn);

    let rpc_url = config.rpc_http_url.clone().unwrap_or_else(|| {
        config.rpc_ws_url.replace("wss://", "https://").replace("ws://", "http://")
    });

    let http_provider = ProviderBuilder::new()
        .on_http(rpc_url.parse().map_err(|e| {
            error::IndexerError::Config(format!("Invalid RPC URL: {e}"))
        })?);

    let chain_head = http_provider.get_block_number().await?;
    tracing::info!("Chain head: {}", chain_head);

    let start_block = if is_empty {
        let blocks_per_day = 43200u64; // ~2s blocks on Base
        let days_back = config.backfill_days as u64;
        chain_head.saturating_sub(blocks_per_day * days_back).max(config.creation_block)
    } else {
        (last_block.unwrap_or(config.creation_block as i64) as u64) + 1
    };

    if start_block < chain_head {
        tracing::info!("Running backfill from block {} to {}", start_block, chain_head);
        backfill::run_backfill(
            &rpc_url,
            config.contract_address,
            start_block,
            chain_head,
            config.rpc_chunk_size,
            pool.clone(),
        )
        .await?;
    } else {
        tracing::info!("No backfill needed, starting from chain head");
    }

    let state = AppState::new(pool.clone(), config);

    let subscriber_handle = {
        let ws_url = state.config.rpc_ws_url.clone();
        let contract_address = state.config.contract_address;
        let pool = pool.clone();
        let shutdown_rx = shutdown_rx.clone();

        tokio::spawn(async move {
            subscriber::subscribe_with_reconnect(ws_url, contract_address, pool, shutdown_rx).await;
        })
    };

    let addr = SocketAddr::from(([0, 0, 0, 0], state.config.server_port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        error::IndexerError::Config(format!("Failed to bind to {}: {}", addr, e))
    })?;

    tracing::info!("API server listening on {}", addr);

    let router = api::create_router(state);

    let server_handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown_signal(shutdown_tx))
            .await
            .ok();
    });

    tokio::select! {
        _ = subscriber_handle => {
            tracing::info!("Subscriber task finished");
        }
        _ = server_handle => {
            tracing::info!("Server task finished");
        }
    }

    tracing::info!("Shutdown complete");
    Ok(())
}

async fn shutdown_signal(shutdown_tx: watch::Sender<bool>) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("Received Ctrl+C, shutting down...");
        }
        _ = terminate => {
            tracing::info!("Received SIGTERM, shutting down...");
        }
    }

    let _ = shutdown_tx.send(true);
}
