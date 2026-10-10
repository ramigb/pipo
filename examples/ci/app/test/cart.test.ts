import { describe, expect, test } from "bun:test";
import { discount, quote, shipping, subtotal } from "../src/cart";

const mug = { sku: "mug", qty: 2, price: 1250 };
const tee = { sku: "tee", qty: 1, price: 2500 };

describe("cart", () => {
  test("subtotal adds up every line", () => {
    expect(subtotal([mug, tee])).toBe(5000);
    expect(subtotal([])).toBe(0);
  });

  test("SAVE10 takes 10% off, rounded down to the cent", () => {
    expect(discount(5000, "SAVE10")).toBe(500);
    expect(discount(1999, "SAVE10")).toBe(199);
  });

  test("FLAT5 needs an order of 20.00 or more", () => {
    expect(discount(2000, "FLAT5")).toBe(500);
    expect(discount(1999, "FLAT5")).toBe(0);
    expect(discount(5000, "NOPE")).toBe(0);
  });

  test("shipping is free from exactly 50.00", () => {
    expect(shipping(5000)).toBe(0);
    expect(shipping(4999)).toBe(495);
    expect(shipping(0)).toBe(0);
  });

  test("a quote applies the discount before shipping", () => {
    expect(quote([mug, tee])).toEqual({ subtotal: 5000, discount: 0, shipping: 0, total: 5000 });
    expect(quote([mug, tee], "SAVE10")).toEqual({ subtotal: 5000, discount: 500, shipping: 495, total: 4995 });
  });
});
