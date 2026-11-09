import { z } from 'zod';

export interface Order {
  id: string;
  ownerId: string;
  items: OrderItem[];
  total: number;
  status: 'open' | 'paid' | 'cancelled';
}

export interface OrderItem {
  sku: string;
  quantity: number;
  price: number;
}

export const CreateOrderBody = z.object({
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
  note: z.string().max(200).optional(),
});
