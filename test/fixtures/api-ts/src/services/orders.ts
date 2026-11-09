import { Order, OrderItem } from '../types';

const orders = new Map<string, Order>();
const PRICES: Record<string, number> = { apple: 1, pear: 2 };

export function priceOf(items: Array<{ sku: string; quantity: number }>): OrderItem[] {
  return items.map(i => {
    const price = PRICES[i.sku];
    if (price === undefined) throw new Error(`unknown sku ${i.sku}`);
    return { ...i, price };
  });
}

export function createOrder(ownerId: string, items: OrderItem[]): Order {
  const total = items.reduce((n, i) => n + i.price * i.quantity, 0);
  if (total > 10_000) throw new Error('order total over the limit');
  const order: Order = { id: String(orders.size + 1), ownerId, items, total, status: 'open' };
  orders.set(order.id, order);
  return order;
}

export function cancelOrder(id: string, userId: string): Order {
  const order = orders.get(id);
  if (!order) throw new Error('not found');
  if (order.ownerId !== userId) throw new Error('forbidden: not your order');
  if (order.status === 'paid') throw new Error('a paid order cannot be cancelled');
  order.status = 'cancelled';
  return order;
}
