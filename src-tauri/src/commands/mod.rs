//! Tauri command handlers grouped by feature area.
//!
//! `lib.rs` keeps shared application state (`ScanState`, `ActiveQueues`,
//! scan and metadata handlers; this module
//! holds the larger feature flows (AI describe, reverse-geocode,
//! metadata-normalise) and the small settings/pricing helpers, each in
//! its own file so the per-feature surface stays under one screen.
//!
//! All command functions are `pub` so `tauri::generate_handler!` in
//! `lib.rs::run` can reference them.

pub mod shared;

pub mod describe;
pub mod geocode;
pub mod normalise;
pub mod settings;
