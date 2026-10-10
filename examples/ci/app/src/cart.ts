// Prices are whole cents, so totals never pick up floating-point dust.
export interface Line {
  sku: string;
  qty: number;
  price: number;
}

export interface Quote {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
}

export const FREE_SHIPPING_FROM = 5000;
export const SHIPPING = 495;

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.price, 0);
}

/** SAVE10 takes 10% off (rounded down to the cent); FLAT5 takes 5.00 off orders of 20.00 or more. */
export function discount(amount: number, code?: string): number {
  if (code === "SAVE10") return Math.floor(amount / 10);
  if (code === "FLAT5" && amount >= 2000) return 500;
  return 0;
}

export function shipping(amount: number): number {
  if (amount === 0) return 0;
  return amount >= FREE_SHIPPING_FROM ? 0 : SHIPPING;
}

export function quote(lines: Line[], code?: string): Quote {
  const sub = subtotal(lines);
  const off = discount(sub, code);
  const ship = shipping(sub - off);
  return { subtotal: sub, discount: off, shipping: ship, total: sub - off + ship };
}
