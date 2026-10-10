// Monotonic ULIDs for packet ids (docs/spec.md §2): time-ordered, 26 chars, Crockford base32. Ports ids.ts.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The last id's time and random part, process-wide, so ids made in the same millisecond stay strictly increasing.
static LAST: Mutex<(u64, [u8; 16])> = Mutex::new((0, [0; 16]));

/// A ULID for now.
pub fn ulid() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    ulid_at(now)
}

/// A ULID for `now_ms`. Within the same millisecond the random part is incremented, as in ids.ts.
pub fn ulid_at(now_ms: u64) -> String {
    let random = {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if now_ms == last.0 {
            let mut i = last.1.len();
            while i > 0 && last.1[i - 1] == 31 {
                last.1[i - 1] = 0;
                i -= 1;
            }
            if i > 0 {
                last.1[i - 1] += 1;
            }
        } else {
            let mut bytes = [0u8; 16];
            rand::fill(&mut bytes);
            last.0 = now_ms;
            last.1 = bytes.map(|b| b & 31);
        }
        last.1
    };
    let mut out = String::with_capacity(26);
    let mut time = [0u8; 10];
    let mut t = now_ms;
    for c in time.iter_mut().rev() {
        *c = ALPHABET[(t % 32) as usize];
        t /= 32;
    }
    out.extend(time.iter().map(|&b| b as char));
    out.extend(random.iter().map(|&n| ALPHABET[n as usize] as char));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_prefix_and_monotonic() {
        let id = ulid_at(1_700_000_000_000);
        assert_eq!(id.len(), 26);
        assert!(id.bytes().all(|b| ALPHABET.contains(&b)));
        // Same prefix as ids.ts gives for this time.
        assert_eq!(&id[..10], "01HF7YAT00");
        assert_eq!(&ulid_at(0)[..10], "0000000000");

        // Within one millisecond: one test, since the state is process-wide.
        let t = 1_234_567_890_123;
        let mut prev = ulid_at(t);
        for _ in 0..1000 {
            let next = ulid_at(t);
            assert!(next > prev, "{next} should sort after {prev}");
            prev = next;
        }
        assert!(ulid() > prev);
    }
}
