use alloy::primitives::Address;
use std::str::FromStr;

use crate::error::{IndexerError, Result};

#[allow(dead_code)]
pub struct Config {
    pub rpc_ws_url: String,
    pub rpc_http_url: Option<String>,
    pub contract_address: Address,
    pub creation_block: u64,
    pub database_path: String,
    pub server_port: u16,
    pub backfill_days: u32,
    pub retention_days: u32,
    pub rpc_chunk_size: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        let rpc_ws_url = std::env::var("RPC_WS_URL")
            .map_err(|_| IndexerError::Config("RPC_WS_URL is required".into()))?;

        let rpc_http_url = std::env::var("RPC_HTTP_URL").ok();

        let contract_address = std::env::var("CONTRACT_ADDRESS")
            .unwrap_or_else(|_| "0x82C9c5475D63e4C9e959280e9066aBb24973a663".into());
        let contract_address = Address::from_str(&contract_address)
            .map_err(|e| IndexerError::Config(format!("Invalid CONTRACT_ADDRESS: {e}")))?;

        let creation_block = std::env::var("CREATION_BLOCK")
            .unwrap_or_else(|_| "37097547".into())
            .parse::<u64>()
            .map_err(|e| IndexerError::Config(format!("Invalid CREATION_BLOCK: {e}")))?;

        let database_path = std::env::var("DATABASE_PATH")
            .unwrap_or_else(|_| "./data/indexer.db".into());

        let server_port = std::env::var("SERVER_PORT")
            .unwrap_or_else(|_| "3000".into())
            .parse::<u16>()
            .map_err(|e| IndexerError::Config(format!("Invalid SERVER_PORT: {e}")))?;

        let backfill_days = std::env::var("BACKFILL_DAYS")
            .unwrap_or_else(|_| "7".into())
            .parse::<u32>()
            .map_err(|e| IndexerError::Config(format!("Invalid BACKFILL_DAYS: {e}")))?;

        let retention_days = std::env::var("RETENTION_DAYS")
            .unwrap_or_else(|_| "7".into())
            .parse::<u32>()
            .map_err(|e| IndexerError::Config(format!("Invalid RETENTION_DAYS: {e}")))?;

        // Default to 10 for Alchemy free tier compatibility
        let rpc_chunk_size = std::env::var("RPC_CHUNK_SIZE")
            .unwrap_or_else(|_| "10".into())
            .parse::<u64>()
            .map_err(|e| IndexerError::Config(format!("Invalid RPC_CHUNK_SIZE: {e}")))?;

        Ok(Self {
            rpc_ws_url,
            rpc_http_url,
            contract_address,
            creation_block,
            database_path,
            server_port,
            backfill_days,
            retention_days,
            rpc_chunk_size,
        })
    }
}
