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
    let random = next_random(&mut LAST.lock().unwrap_or_else(|e| e.into_inner()), now_ms);
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

/// The random part for `now_ms`: the last one plus one within the same millisecond, else fresh.
fn next_random(last: &mut (u64, [u8; 16]), now_ms: u64) -> [u8; 16] {
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

        // Within one millisecond, on local state: other tests make ids on other threads meanwhile.
        let t = 1_234_567_890_123;
        let mut last = (0, [0u8; 16]);
        let mut prev = next_random(&mut last, t);
        for _ in 0..1000 {
            let next = next_random(&mut last, t);
            assert!(next > prev, "{next:?} should sort after {prev:?}");
            prev = next;
        }
        assert!(ulid() > ulid_at(t));
    }
}
