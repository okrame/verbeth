use std::collections::VecDeque;
use tokio::sync::Mutex;

use super::processor::LogWithMeta;

const MAX_RETRIES: u32 = 3;
const MAX_QUEUE_SIZE: usize = 1000;

pub struct FailedEvent {
    pub log: LogWithMeta,
    pub retry_count: u32,
    pub last_error: String,
}

pub struct RetryQueue {
    queue: Mutex<VecDeque<FailedEvent>>,
}

impl RetryQueue {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
        }
    }

    pub async fn push(&self, log: LogWithMeta, error: String) {
        let mut q = self.queue.lock().await;

        // Check if we're at capacity - dead-letter oldest event
        if q.len() >= MAX_QUEUE_SIZE {
            if let Some(old) = q.pop_front() {
                tracing::error!(
                    block = old.log.block_number,
                    log_index = old.log.log_index,
                    retries = old.retry_count,
                    error = %old.last_error,
                    "Event permanently failed (dead-letter, queue full)"
                );
            }
        }

        q.push_back(FailedEvent {
            log,
            retry_count: 0,
            last_error: error,
        });
    }

    pub async fn push_retry(&self, mut event: FailedEvent, error: String) {
        event.retry_count += 1;
        event.last_error = error;

        if event.retry_count >= MAX_RETRIES {
            // Dead-letter: log and discard
            tracing::error!(
                block = event.log.block_number,
                log_index = event.log.log_index,
                retries = event.retry_count,
                error = %event.last_error,
                "Event permanently failed (dead-letter, max retries)"
            );
            return;
        }

        let mut q = self.queue.lock().await;
        q.push_back(event);
    }

    pub async fn pop(&self) -> Option<FailedEvent> {
        self.queue.lock().await.pop_front()
    }

    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }
}

impl Default for RetryQueue {
    fn default() -> Self {
        Self::new()
    }
}
