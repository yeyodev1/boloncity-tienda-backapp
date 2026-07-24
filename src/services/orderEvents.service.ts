import { IOrder } from "../models/Order";

type OrderListener = (order: IOrder) => void;

const listeners = new Map<string, Set<OrderListener>>();

export function subscribeToOrder(orderId: string, listener: OrderListener) {
  const orderListeners = listeners.get(orderId) || new Set<OrderListener>();
  orderListeners.add(listener);
  listeners.set(orderId, orderListeners);

  return () => {
    orderListeners.delete(listener);
    if (orderListeners.size === 0) listeners.delete(orderId);
  };
}

export function publishOrderUpdate(order: IOrder & { _id: unknown }) {
  const orderListeners = listeners.get(String(order._id));
  if (!orderListeners) return;

  for (const listener of orderListeners) listener(order);
}
