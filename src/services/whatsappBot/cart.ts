import { meaningfulTokens, tokenSimilarity } from "./catalog";

/** Renglón del carrito de la conversación. El precio NO se guarda: se recalcula siempre desde Mongo. */
export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
}

/** Tope de unidades por producto en un pedido de WhatsApp. */
export const MAX_QUANTITY = 50;

function clampQuantity(value: unknown) {
  return Math.max(1, Math.min(Math.round(Number(value) || 1), MAX_QUANTITY));
}

/** Agrega sumando si el producto ya estaba ("otro bolón mixto" = +1, no un renglón nuevo). */
export function addToCart(cart: CartItem[], item: CartItem): CartItem[] {
  const existing = cart.find((current) => current.productId === item.productId);
  if (existing) {
    return cart.map((current) =>
      current.productId === item.productId ? { ...current, quantity: clampQuantity(current.quantity + item.quantity) } : current
    );
  }
  return [...cart, { ...item, quantity: clampQuantity(item.quantity) }];
}

export function removeFromCart(cart: CartItem[], productId: string): CartItem[] {
  return cart.filter((item) => item.productId !== productId);
}

export function setCartQuantity(cart: CartItem[], productId: string, quantity: number): CartItem[] {
  if (quantity <= 0) return removeFromCart(cart, productId);
  return cart.map((item) => (item.productId === productId ? { ...item, quantity: clampQuantity(quantity) } : item));
}

/**
 * Encuentra en el carrito el renglón al que se refiere el cliente ("quita el café").
 * Busca solo dentro del carrito: con dos o tres renglones, "café" basta.
 */
export function findInCart(cart: CartItem[], query: string): CartItem | null {
  const tokens = meaningfulTokens(query);
  if (!tokens.length) return cart.length === 1 ? cart[0] : null;
  const matches = cart
    .map((item) => {
      const itemTokens = meaningfulTokens(item.name);
      const hits = tokens.filter((token) => itemTokens.some((candidate) => tokenSimilarity(token, candidate) >= 0.7)).length;
      return { item, hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (!matches.length) return null;
  if (matches.length > 1 && matches[0].hits === matches[1].hits) return null;
  return matches[0].item;
}

export function cartUnits(cart: CartItem[]) {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}
