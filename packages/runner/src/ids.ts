// Monotonic ULIDs for packet ids (docs/spec.md §2): time-ordered, 26 chars, Crockford base32.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    // Same millisecond: increment the random part so ids stay strictly increasing.
    let i = lastRandom.length - 1;
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
    if (i >= 0) lastRandom[i] = (lastRandom[i] as number) + 1;
  } else {
    lastTime = now;
    lastRandom = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b & 31);
  }
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((n) => ALPHABET[n]).join("");
}
