// The runner's control socket (docs/spec.md §7.2, D24): protocol, server and ops. Port of control/*.ts.

pub mod ops;
pub mod protocol;
pub mod reads;
pub mod rerun;
pub mod server;
pub mod versions;

pub use protocol::ControlError;
