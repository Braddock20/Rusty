pub mod eal;
pub mod gt;
pub mod betika;
use serde::Serialize;
#[derive(Serialize)]
pub struct Outcome { pub source: String, pub ok: bool, pub records: usize, pub message: String }
